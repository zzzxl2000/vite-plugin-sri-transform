import { createHash } from 'crypto'
import path from 'path'
import * as cheerio from 'cheerio'
import type { Plugin, ResolvedConfig } from 'vite'
import type { OutputBundle } from 'rollup';


const VITE_INTERNAL_ANALYSIS_PLUGIN = 'vite:build-import-analysis'
const EXTERNAL_SCRIPT_RE: RegExp  =
  /<script[^<>]*['"]*src['"]*=['"]*([^ '"]+)['"]*[^<>]*><\/script>/g
const EXTERNAL_CSS_RE: RegExp =
  /<link[^<>]*['"]*rel['"]*=['"]*stylesheet['"]*[^<>]+['"]*href['"]*=['"]([^^ '"]+)['"][^<>]*>/g
const EXTERNAL_MODULE_RE: RegExp =
  /<link[^<>]*['"]*rel['"]*=['"]*modulepreload['"]*[^<>]+['"]*href['"]*=['"]([^^ '"]+)['"][^<>]*>/g
const OTHER_CSS_RE: RegExp =
  /<link[^<>]*['"]*href['"]*=['"]([^'"]+)['"][^<>]*rel=['"]*stylesheet['"][^<>]*>/g

function hijackGenerateBundle(plugin:Plugin, afterHook: Function) {
  const hook = plugin.generateBundle

  if (typeof afterHook !== 'function') return

  if (typeof hook === 'object' && hook.handler) {
    const originalHandler = hook.handler
    hook.handler = async function (...args) {
      await originalHandler.apply(this, args)
      await afterHook.apply(this, args)
    }
  } else if (typeof hook === 'function') {
    plugin.generateBundle = async function (...args) {
      await hook.apply(this, args)
      await afterHook.apply(this, args)
    }
  }
}

export default function sri(options: {ignoreMissingAsset?: boolean}) {
  const { ignoreMissingAsset = false } = options || {}

  return {
    name: 'vite-plugin-sri-transform',
    enforce: 'post',
    apply: 'build',
    configResolved(config: ResolvedConfig) {
      const generateBundle = async function (_: any, bundle: OutputBundle) {
        const getBundleKey = (htmlPath: string, url: string) => {
          if (config.base === './' || config.base === '') {
            return path.posix.resolve(htmlPath, url)
          }
          return url.replace(config.base, '')
        }

        const calculateIntegrity = async (htmlPath: string, url: string) => {
          let source
          const resourcePath = url
          if (resourcePath.startsWith('http')) {
            source = Buffer.from(
              await (await fetch(resourcePath)).arrayBuffer()
            )
          } else {
            const bundleItem = bundle[getBundleKey(htmlPath, url)]
            if (!bundleItem) {
              if (ignoreMissingAsset) return null
              throw new Error(`${url} error`)
            }

            source =
              bundleItem.type === 'chunk' ? bundleItem.code : bundleItem.source
          }
          return `sha384-${createHash('sha384')
            .update(source)
            .digest()
            .toString('base64')}`
        }

        //  ---
        const transformHTML = async function (
          regex: RegExp,
          endOffset: number,
          htmlPath: string,
          html: string
        ) {
          let match
          const changes = []
          let offset = 0
          while ((match = regex.exec(html))) {
            const [, url] = match
            const end = regex.lastIndex

            const integrity = await calculateIntegrity(htmlPath, url)
            if (!integrity) continue

            const insertPos = end - endOffset
            changes.push({ integrity, insertPos })
          }
          for (const change of changes) {
            const insertText = ` integrity="${change.integrity}" `
            let htmlContent = html.slice(0, change.insertPos + offset)

            html =
              htmlContent + insertText + html.slice(change.insertPos + offset)
            offset += insertText.length
          }
          return html
        }

        const transFormCrossOrigin = function (html: string) {
          const $html = cheerio.load(html)

          $html('link').each(function (this: cheerio.Element) {
            if (!$html(this).attr('crossorigin')) {
              $html(this).attr('crossorigin', 'anonymous')
            }
          })

          $html('script').each(function (this: cheerio.Element) {
            if (!$html(this).attr('crossorigin')) {
              $html(this).attr('crossorigin', 'anonymous')
            }
          })
          return $html.html()
        }

        for (const name in bundle) {
          const chunk = bundle[name]

          if (
            chunk.type === 'asset' &&
            (chunk.fileName.endsWith('.html') ||
              chunk.fileName.endsWith('.htm'))
          ) {
            let html = chunk.source.toString()

            html = await transformHTML(EXTERNAL_SCRIPT_RE, 10, name, html)
            html = await transformHTML(EXTERNAL_CSS_RE, 1, name, html)
            html = await transformHTML(EXTERNAL_MODULE_RE, 1, name, html)
            html = await transformHTML(OTHER_CSS_RE, 1, name, html)

            chunk.source = transFormCrossOrigin(html)
          }
        }
      }

      const plugin: Plugin | undefined = config.plugins.find(
        (p: Plugin) => p.name === VITE_INTERNAL_ANALYSIS_PLUGIN
      )
      if (!plugin) throw new Error('pluginSri 版本不兼容')

      hijackGenerateBundle(plugin, generateBundle)
    },
  }
}
