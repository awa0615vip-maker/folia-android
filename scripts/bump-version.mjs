#!/usr/bin/env node
// 发版版本号递增：把 package.json version 的最后一段数字 +1（versionName 取自它），
// 同时把 android/app/build.gradle 的 versionCode +1。
//
// 用法：
//   node scripts/bump-version.mjs          版本号末位 +1（如 0.7.17-android.124 -> .125，versionCode 162 -> 163）
//   node scripts/bump-version.mjs 126      直接把版本号末位指定为某个数字（versionCode 仍自动 +1）
//
// 这样每次发出的 APK 版本号都单调上涨，用户在“设置 → 关于”里就能看出自己装的是不是最新版。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = resolve(root, 'package.json');
const gradlePath = resolve(root, 'android/app/build.gradle');

const packageJsonRaw = readFileSync(packageJsonPath, 'utf8');
const pkg = JSON.parse(packageJsonRaw);
const currentVersion = String(pkg.version || '');

// 捕获版本号末尾连续数字段（如 0.7.17-android.124 的 124）。
// 前缀非贪婪，使 \d+ 落在“最后一段数字”上，后缀只允许非数字（通常为空）。
const match = currentVersion.match(/^(.*?)(\d+)(\D*)$/);
if (!match) {
    console.error(`[bump] 无法解析 package.json 版本号："${currentVersion}"`);
    process.exit(1);
}
const [, prefix, lastNumStr, suffix] = match;
const explicit = process.argv[2];
const nextLastNum = explicit
    ? Number.parseInt(explicit, 10)
    : Number.parseInt(lastNumStr, 10) + 1;
if (!Number.isFinite(nextLastNum) || nextLastNum <= Number.parseInt(lastNumStr, 10)) {
    if (explicit && Number.isFinite(Number.parseInt(explicit, 10))) {
        // 允许显式指定为相同值（幂等），其余非法情况报错。
    } else {
        console.error(`[bump] 计算出的新版本号无效：${nextLastNum}`);
        process.exit(1);
    }
}
const nextVersion = `${prefix}${nextLastNum}${suffix}`;

// 只替换 version 行，保留 package.json 其余格式不变。
const newPackageJsonRaw = packageJsonRaw.replace(
    /^(\s*"version"\s*:\s*")[^"]*("(?:\s*,)?\s*)$/m,
    `$1${nextVersion}$2`,
);
if (newPackageJsonRaw === packageJsonRaw) {
    console.error('[bump] package.json 替换失败：未找到 version 字段');
    process.exit(1);
}
writeFileSync(packageJsonPath, newPackageJsonRaw, 'utf8');

// versionCode +1。
const gradleRaw = readFileSync(gradlePath, 'utf8');
let newVersionCode = null;
const newGradleRaw = gradleRaw.replace(
    /versionCode\s+(\d+)/,
    (whole, code) => {
        newVersionCode = Number.parseInt(code, 10) + 1;
        return `versionCode ${newVersionCode}`;
    },
);
if (newVersionCode === null) {
    console.error('[bump] build.gradle 替换失败：未找到 versionCode');
    process.exit(1);
}
writeFileSync(gradlePath, newGradleRaw, 'utf8');

console.log(`[bump] versionName: ${currentVersion} -> ${nextVersion}`);
console.log(`[bump] versionCode:  -> ${newVersionCode}`);
