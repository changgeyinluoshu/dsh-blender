/**
 * 验证用解析钩子：把 @deepseek-ai/* 说明符解析到 DSH 应用自带的 node_modules，
 * 从而在不复制、不安装的前提下复现宿主加载插件时的模块解析环境。
 * 若 DSH 不在默认位置，设置环境变量 DSH_APP_ROOT 指向 resources/app。
 */
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const APP = process.env.DSH_APP_ROOT
  ? process.env.DSH_APP_ROOT + '/node_modules'
  : 'D:/dsh d/DSH Desktop Beta/resources/app/node_modules'

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'dsh-blender-studio') {
    return nextResolve(specifier, context)
  }
  try {
    return await nextResolve(specifier, context)
  } catch {
    /* 落到应用自带的 node_modules */
  }

  if (specifier === 'dsh-blender-studio') return nextResolve(specifier, context)

  const [scope, name, ...rest] = specifier.split('/')
  const pkgDir = `${APP}/${scope}/${name}`
  if (rest.length > 0) {
    return { url: pathToFileURL(`${pkgDir}/${rest.join('/')}`).href, shortCircuit: true }
  }

  const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
  let entry = pkg.exports?.['.'] ?? pkg.module ?? pkg.main ?? './index.js'
  if (typeof entry === 'object') entry = entry.import ?? entry.default ?? entry.require
  return { url: pathToFileURL(`${pkgDir}/${String(entry).replace(/^\.\//, '')}`).href, shortCircuit: true }
}
