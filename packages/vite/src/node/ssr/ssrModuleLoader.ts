import fs from 'fs'
import path from 'path'
import { ViteDevServer } from '..'
import { cleanUrl, resolveFrom, unwrapId } from '../utils'
import { ssrRewriteStacktrace } from './ssrStacktrace'
import {
  ssrExportAllKey,
  ssrModuleExportsKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrDynamicImportKey
} from './ssrTransform'
import { transformRequest } from '../server/transformRequest'

interface SSRContext {
  global: NodeJS.Global
}

type SSRModule = Record<string, any>
type ImportsStack = string[]

const pendingModules = new Map<string, Promise<SSRModule>>()
const pendingImports = new Map<string, Set<string>>()
const erroredModules = new Map<string, ImportsStack>()

export { ssrLoadModuleAndRetryFailedModules as ssrLoadModule }
async function ssrLoadModuleAndRetryFailedModules(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: ImportsStack = []
): Promise<SSRModule> {
	debugger
  const mod = await ssrLoadModule(url, server, context, urlStack)
  if (erroredModules.size) {
    await retryFailedModules(server, context)
  }
  return mod
}

async function retryFailedModules(
  server: ViteDevServer,
  context: SSRContext = { global }
) {
  for (const [modToRetryUrl, modToRetryUrlStack] of erroredModules.entries()) {
    await ssrLoadModule(modToRetryUrl, server, context, modToRetryUrlStack)
  }
}

async function ssrLoadModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: ImportsStack = []
): Promise<SSRModule> {
  url = unwrapId(url)

  if (urlStack.includes(url)) {
    server.config.logger.warn(
      `Circular dependency: ${urlStack.join(' -> ')} -> ${url}`
    )
    return {}
  }

  // when we instantiate multiple dependency modules in parallel, they may
  // point to shared modules. We need to avoid duplicate instantiation attempts
  // by register every module as pending synchronously so that all subsequent
  // request to that module are simply waiting on the same promise.
  const pending = pendingModules.get(url)
  if (pending) {
    return pending
  }

  const modulePromise = instantiateModule(url, server, context, urlStack)
  pendingModules.set(url, modulePromise)

	const result = modulePromise.then(([mod, err]) => {
		if (err) {
			erroredModules.set(url, urlStack)
		} else {
			erroredModules.delete(url)
		}
		pendingModules.delete(url)
		pendingImports.delete(url)
		return mod
	})
	
	return result
}

async function instantiateModule(
  url: string,
  server: ViteDevServer,
  context: SSRContext = { global },
  urlStack: ImportsStack = []
): Promise<[SSRModule, Error?]> {
  const { moduleGraph } = server
  const mod = await moduleGraph.ensureEntryFromUrl(url)

  if (mod.ssrModule && !erroredModules.has(url)) {
    return [mod.ssrModule]
  }

  const result =
    mod.ssrTransformResult ||
    (await transformRequest(url, server, { ssr: true }))
  if (!result) {
    // TODO more info? is this even necessary?
    throw new Error(`failed to load module for ssr: ${url}`)
  }

  urlStack = urlStack.concat(url)

  if (!mod.ssrModule) {
	  const ssrModule = {
	    [Symbol.toStringTag]: 'Module'
	  }
	  Object.defineProperty(ssrModule, '__esModule', { value: true })

	  // Tolerate circular imports by ensuring the module can be
	  // referenced before it's been instantiated.
	  mod.ssrModule = ssrModule
  }

  const isExternal = (dep: string) => dep[0] !== '.' && dep[0] !== '/'

  if (result.deps?.length) {
    // Store the parsed dependencies while this module is loading,
    // so dependent modules can avoid waiting on a circular import.
    pendingImports.set(url, new Set(result.deps))

    // Load dependencies one at a time to ensure modules are
    // instantiated in a predictable order.
    await result.deps.reduce(
      (queue, dep) =>
        isExternal(dep)
          ? queue
          : queue.then(async () => {
              const deps = pendingImports.get(dep)
              if (!deps || !urlStack.some((url) => deps.has(url))) {
                await ssrLoadModule(dep, server, context, urlStack)
              }
            }),
      Promise.resolve()
    )
  }

  const ssrImportMeta = { url }

  const ssrImport = (dep: string) => {
    if (isExternal(dep)) {
      return nodeRequire(dep, mod.file, server.config.root)
    } else {
      return moduleGraph.urlToModuleMap.get(unwrapId(dep))?.ssrModule
    }
  }

  const ssrDynamicImport = (dep: string) => {
    if (isExternal(dep)) {
      return Promise.resolve(nodeRequire(dep, mod.file, server.config.root))
    } else {
      // #3087 dynamic import vars is ignored at rewrite import path,
      // so here need process relative path
      if (dep.startsWith('.')) {
        dep = path.posix.resolve(path.dirname(url), dep)
      }
      return ssrLoadModule(dep, server, context, urlStack)
    }
  }

  function ssrExportAll(sourceModule: any) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        Object.defineProperty(mod.ssrModule, key, {
          enumerable: true,
          configurable: true,
          get() {
            return sourceModule[key]
          }
        })
      }
    }
  }

  try {
    new Function(
      `global`,
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      result.code + `\n//# sourceURL=${mod.url}`
    )(
      context.global,
      mod.ssrModule,
      ssrImportMeta,
      ssrImport,
      ssrDynamicImport,
      ssrExportAll
    )
  } catch (e) {
    e.stack = ssrRewriteStacktrace(e.stack, moduleGraph)
    server.config.logger.error(
      `Error when evaluating SSR module ${url}:\n${e.stack}`,
      {
        timestamp: true,
        clear: server.config.clearScreen
      }
    )

    return [mod.ssrModule, e]
  }

  return [Object.freeze(mod.ssrModule)]
}

function nodeRequire(id: string, importer: string | null, root: string) {
  const mod = require(resolve(id, importer, root))
  const defaultExport = mod.__esModule ? mod.default : mod
  // rollup-style default import interop for cjs
  return new Proxy(mod, {
    get(mod, prop) {
      if (prop === 'default') return defaultExport
      return mod[prop]
    }
  })
}

const resolveCache = new Map<string, string>()

function resolve(id: string, importer: string | null, root: string) {
  const key = id + importer + root
  const cached = resolveCache.get(key)
  if (cached) {
    return cached
  }
  const resolveDir =
    importer && fs.existsSync(cleanUrl(importer))
      ? path.dirname(importer)
      : root
  const resolved = resolveFrom(id, resolveDir, true)
  resolveCache.set(key, resolved)
  return resolved
}
