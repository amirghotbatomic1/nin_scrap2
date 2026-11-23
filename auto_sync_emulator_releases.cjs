#!/usr/bin/env node

/**
 * 🎮 Auto Emulator Releases Downloader & AbreHamrahi Cloud Sync
 * 
 * Target Emulators:
 *  - Lichii (https://github.com/zortos293/Lichii/releases) -> Windows (x64), Linux (.AppImage), macOS (arm64)
 *  - Fritchii (https://github.com/Frizti/Fritchii/releases) -> Windows (x64), Linux (.AppImage), macOS (arm64)
 *  - Eden NX2 Android (https://git.eden-emu.dev/moceure/eden-nx2-android/releases) -> Android (.apk)
 *  - BananaNative (https://github.com/Raphix91/BananaNative/releases) -> Android (.apk)
 * 
 * Features:
 *  1. Checks latest releases daily via GitHub / Forgejo APIs.
 *  2. Identifies matching OS binaries (Windows 64-bit, Linux AppImage, macOS ARM64, Android APK).
 *  3. In AbreHamrahi, creates folders categorized with the version name:
 *     e.g. Nintendo_Switch/Emulators/<Emulator_Name>/<Version>/<Platform>/
 *  4. Cleans up older version folders/files in AbreHamrahi when a new version is detected and uploaded.
 *  5. Automatically saves new release links to website database if configured.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
    getAccessToken,
    resolveFolderPath,
    findExistingFileInHamrahi,
    uploadFileToHamrahi,
    deleteObjectInHamrahi,
    request
} = require('./hamrahi_uploader.cjs');

// Parse CLI Flags
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].substring(2);
        const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
        params[key] = val;
    }
}

const REFRESH_TOKEN = params['refresh-token'] || process.env.ABREHAMRAHI_REFRESH_TOKEN;
const GITHUB_TOKEN = params['github-token'] || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const SITE_URL = (params['api-url'] || process.env.SITE_URL || process.env.APP_URL || '').replace(/\/$/, '');
const SYNC_TOKEN = params['api-token'] || process.env.SYNC_API_TOKEN || '';
const DEST_DIR = params['dest-dir'] || path.join(process.cwd(), 'downloads_auto_emulators');

const EMULATOR_CONFIGS = [
    {
        name: 'Lichii',
        slug: 'lichii',
        sourceType: 'github',
        repo: 'zortos293/Lichii',
        platforms: ['windows', 'linux', 'macos']
    },
    {
        name: 'Fritchii',
        slug: 'fritchii',
        sourceType: 'github',
        repo: 'Frizti/Fritchii',
        platforms: ['windows', 'linux', 'macos']
    },
    {
        name: 'Eden NX2 Android',
        slug: 'eden-nx2-android',
        sourceType: 'forgejo',
        apiUrl: 'https://git.eden-emu.dev/api/v1/repos/moceure/eden-nx2-android/releases',
        htmlUrl: 'https://git.eden-emu.dev/moceure/eden-nx2-android/releases',
        platforms: ['android']
    },
    {
        name: 'BananaNative',
        slug: 'banananative',
        sourceType: 'github',
        repo: 'Raphix91/BananaNative',
        platforms: ['android']
    }
];

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const p = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, p)).toFixed(1) + ' ' + units[p];
}

/**
 * Generic JSON fetcher with optional auth header and redirect handling
 */
function fetchJson(urlStr, headers = {}, retries = 3) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const client = u.protocol === 'https:' ? https : http;

        const options = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
                'Accept': 'application/json',
                ...headers
            },
            timeout: 25000
        };

        const req = client.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchJson(res.headers.location, headers, retries - 1));
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (retries > 0) setTimeout(() => resolve(fetchJson(urlStr, headers, retries - 1)), 2000);
            else reject(new Error(`Timeout fetching ${urlStr}`));
        });

        req.on('error', (err) => {
            if (retries > 0) setTimeout(() => resolve(fetchJson(urlStr, headers, retries - 1)), 2000);
            else reject(err);
        });

        req.end();
    });
}

/**
 * Fetch latest release information from GitHub or Forgejo
 */
async function fetchLatestRelease(config) {
    if (config.sourceType === 'github') {
        const url = `https://api.github.com/repos/${config.repo}/releases/latest`;
        const headers = {};
        if (GITHUB_TOKEN) {
            headers['Authorization'] = `token ${GITHUB_TOKEN}`;
        }
        const res = await fetchJson(url, headers);
        if (res.status === 200 && res.data && res.data.tag_name) {
            return {
                tag: res.data.tag_name,
                name: res.data.name || res.data.tag_name,
                published_at: res.data.published_at,
                assets: (res.data.assets || []).map(a => ({
                    name: a.name,
                    size: a.size,
                    download_url: a.browser_download_url
                }))
            };
        }
        // Fallback: list releases if /latest fails (e.g. pre-releases)
        const listUrl = `https://api.github.com/repos/${config.repo}/releases?per_page=1`;
        const listRes = await fetchJson(listUrl, headers);
        if (listRes.status === 200 && Array.isArray(listRes.data) && listRes.data.length > 0) {
            const rel = listRes.data[0];
            return {
                tag: rel.tag_name,
                name: rel.name || rel.tag_name,
                published_at: rel.published_at,
                assets: (rel.assets || []).map(a => ({
                    name: a.name,
                    size: a.size,
                    download_url: a.browser_download_url
                }))
            };
        }
        throw new Error(`Failed to fetch GitHub releases for ${config.repo}: Status ${res.status}`);
    } else if (config.sourceType === 'forgejo') {
        const res = await fetchJson(config.apiUrl);
        if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
            const rel = res.data[0];
            return {
                tag: rel.tag_name,
                name: rel.name || rel.tag_name,
                published_at: rel.published_at,
                assets: (rel.assets || []).map(a => ({
                    name: a.name,
                    size: a.size,
                    download_url: a.browser_download_url
                }))
            };
        }
        throw new Error(`Failed to fetch Forgejo releases from ${config.apiUrl}: Status ${res.status}`);
    }
}

/**
 * Filter assets by target operating systems
 * Categories requested:
 *  - Windows 64-bit (.zip, .exe, .msi, win, x64, 64)
 *  - Linux AppImage (.AppImage)
 *  - Mac arm (.dmg, .tar.gz, .zip, mac, osx, darwin, arm, arm64, aarch64, m1, apple)
 *  - Android (.apk)
 */
function classifyAssets(assets, targetPlatforms) {
    const matched = [];

    for (const asset of assets) {
        const fn = asset.name.toLowerCase();

        // Exclude symbols, debug, checksums, source code archives
        if (fn.endsWith('.md5') || fn.endsWith('.sha256') || fn.endsWith('.txt') || fn.endsWith('.asc') || fn.endsWith('.sig') || fn.includes('symbols') || fn.includes('debug')) {
            continue;
        }

        // 1. Android APK
        if (targetPlatforms.includes('android')) {
            if (fn.endsWith('.apk') || (fn.includes('android') && (fn.endsWith('.zip') || fn.endsWith('.apk')))) {
                matched.push({
                    platform: 'android',
                    arch: 'arm64',
                    asset
                });
                continue;
            }
        }

        // 2. Linux AppImage
        if (targetPlatforms.includes('linux')) {
            if (fn.endsWith('.appimage') || (fn.includes('.appimage.') && !fn.endsWith('.zsync'))) {
                matched.push({
                    platform: 'linux',
                    arch: 'x64',
                    asset
                });
                continue;
            }
        }

        // 3. macOS ARM (Apple Silicon / arm64)
        if (targetPlatforms.includes('macos')) {
            const isMac = fn.includes('mac') || fn.includes('osx') || fn.includes('darwin') || fn.includes('apple');
            const isArm = fn.includes('arm64') || fn.includes('aarch64') || fn.includes('arm') || fn.includes('universal') || fn.includes('m1') || fn.includes('m2');
            if (isMac && isArm && (fn.endsWith('.dmg') || fn.endsWith('.tar.gz') || fn.endsWith('.zip') || fn.endsWith('.7z'))) {
                matched.push({
                    platform: 'macos',
                    arch: 'arm64',
                    asset
                });
                continue;
            }
        }

        // 4. Windows 64-bit
        if (targetPlatforms.includes('windows')) {
            const isWin = fn.includes('win') || fn.includes('windows') || fn.includes('msvc');
            const is64 = fn.includes('x64') || fn.includes('x86_64') || fn.includes('64') || fn.includes('win64');
            const isExeOrArchive = fn.endsWith('.zip') || fn.endsWith('.7z') || fn.endsWith('.exe') || fn.endsWith('.msi');
            if (isWin && is64 && isExeOrArchive) {
                matched.push({
                    platform: 'windows',
                    arch: 'x64',
                    asset
                });
                continue;
            }
        }
    }

    // Deduplicate: Keep one primary asset per platform
    const deduplicated = [];
    for (const p of targetPlatforms) {
        const found = matched.find(m => m.platform === p);
        if (found) {
            deduplicated.push(found);
        }
    }

    return deduplicated;
}

/**
 * List all objects (folders and files) inside a folder in AbreHamrahi
 */
async function listObjectsInFolder(accessToken, folderId, refreshToken = null) {
    let activeToken = accessToken;
    const listPath = folderId 
        ? `/api/v2/flat/list-objects/?parent=${folderId}&page_size=100` 
        : '/api/v2/flat/list-objects/?page_size=100';

    let res = await request({
        hostname: 'abrehamrahi.ir',
        path: listPath,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${activeToken}`,
            'Accept': 'application/json'
        }
    });

    if ((res.status === 401 || (res.body && res.body.code === 'token_not_valid')) && refreshToken) {
        activeToken = await getAccessToken(refreshToken);
        res = await request({
            hostname: 'abrehamrahi.ir',
            path: listPath,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${activeToken}`,
                'Accept': 'application/json'
            }
        });
    }

    if (res.status === 200 && Array.isArray(res.body.results)) {
        return res.body.results;
    }
    return [];
}

/**
 * Clean up old version folders or files in AbreHamrahi
 * Preserves the current version folder and removes all previous/outdated version folders.
 */
async function cleanupOldVersionsInHamrahi(accessToken, baseFolderId, currentVersionClean, refreshToken = null) {
    try {
        console.log(`    🧹 Checking for old versions to remove in AbreHamrahi (Current: ${currentVersionClean})...`);
        const items = await listObjectsInFolder(accessToken, baseFolderId, refreshToken);
        
        for (const item of items) {
            const itemNameClean = item.name.trim();
            // If it's a version folder and not matching current version, delete it
            if (item.type === 'folder' && itemNameClean.toLowerCase() !== currentVersionClean.toLowerCase()) {
                console.log(`    🗑️ Deleting outdated version folder from AbreHamrahi: "${item.name}" (ID: ${item.id})...`);
                await deleteObjectInHamrahi(accessToken, item.id, refreshToken);
            }
        }
    } catch (err) {
        console.warn(`    ⚠️ Cleanup warning: ${err.message}`);
    }
}

/**
 * High speed downloader using curl / aria2
 */
async function downloadBinary(url, destPath) {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    console.log(`    ⏳ Downloading: ${url}`);
    try {
        execSync(`curl -L --retry 3 -s -S -A "${userAgent}" --connect-timeout 30 --max-time 600 -o "${destPath}" "${url}"`, {
            stdio: 'inherit'
        });
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
            return destPath;
        }
    } catch (e) {
        console.log(`    ⚠️ curl failed (${e.message}). Attempting aria2...`);
    }

    let hasAria2 = false;
    try {
        execSync('which aria2c', { stdio: 'ignore' });
        hasAria2 = true;
    } catch {}

    if (hasAria2) {
        try {
            const outName = path.basename(destPath);
            execSync(`aria2c -x 4 -s 4 --connect-timeout=30 --timeout=45 --max-tries=3 --user-agent="${userAgent}" --allow-overwrite=true --dir="${dir}" -o "${outName}" "${url}"`, {
                stdio: 'inherit',
                timeout: 600000
            });
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
                return destPath;
            }
        } catch (err) {
            throw new Error(`aria2c download failed: ${err.message}`);
        }
    }

    if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 1024) {
        throw new Error(`Downloaded file is invalid or missing: ${destPath}`);
    }

    return destPath;
}

/**
 * Optionally save or update release info in website database
 */
async function notifyWebsite(payload) {
    if (!SITE_URL || !SYNC_TOKEN) return;

    return new Promise((resolve) => {
        const u = new URL(`${SITE_URL}/api/v1/emulators/sync/save-release`);
        const client = u.protocol === 'https:' ? https : http;
        const bodyStr = JSON.stringify(payload);

        const req = client.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'Accept': 'application/json',
                'X-SYNC-TOKEN': SYNC_TOKEN,
                'User-Agent': 'Emulator-AutoRelease-Sync/1.0'
            },
            timeout: 15000
        }, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, body: d });
            });
        });

        req.on('error', (err) => resolve({ status: 500, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 408 }); });
        req.write(bodyStr);
        req.end();
    });
}

/**
 * Main Execution Loop
 */
async function main() {
    console.log('===========================================================');
    console.log('🎮 GitHub/Forgejo Emulator Releases Sync & AbreHamrahi');
    console.log('===========================================================');

    if (!REFRESH_TOKEN) {
        console.error('❌ Error: Missing ABREHAMRAHI_REFRESH_TOKEN.');
        process.exit(1);
    }

    console.log('🔑 Authenticating with AbreHamrahi Cloud...');
    let accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ Authenticated successfully.\n');

    const summaryReport = [];

    for (const emu of EMULATOR_CONFIGS) {
        console.log(`-----------------------------------------------------------`);
        console.log(`🔍 Checking updates for ${emu.name} (${emu.slug})...`);
        console.log(`-----------------------------------------------------------`);

        let release = null;
        try {
            release = await fetchLatestRelease(emu);
            console.log(`   🏷️ Latest Version: ${release.tag} (Published: ${release.published_at || 'N/A'})`);
            console.log(`   📦 Found ${release.assets.length} assets.`);
        } catch (fetchErr) {
            console.error(`   ❌ Failed to fetch releases for ${emu.name}: ${fetchErr.message}`);
            continue;
        }

        const matchedAssets = classifyAssets(release.assets, emu.platforms);
        if (matchedAssets.length === 0) {
            console.warn(`   ⚠️ No matching target assets found for ${emu.name} (Platforms: ${emu.platforms.join(', ')}).`);
            continue;
        }

        // Clean version tag for folder name (e.g. "v1.2.3" -> "v1.2.3")
        const versionClean = (release.tag || 'latest').trim().replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const baseFolder = `Nintendo_Switch/Emulators/${emu.name.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
        
        console.log(`   🗂️ Resolving base folder: "${baseFolder}"...`);
        const baseFolderId = await resolveFolderPath(accessToken, baseFolder, REFRESH_TOKEN);

        // Subfolder naming format requested: version included in folder name
        const versionFolder = `${baseFolder}/${versionClean}`;
        console.log(`   🗂️ Resolving versioned folder: "${versionFolder}"...`);
        const versionFolderId = await resolveFolderPath(accessToken, versionFolder, REFRESH_TOKEN);

        for (const item of matchedAssets) {
            const { platform, arch, asset } = item;
            const fileName = asset.name;
            const downloadUrl = asset.download_url;
            console.log(`\n   🎯 [${platform.toUpperCase()} - ${arch}] Asset: ${fileName} (${formatBytes(asset.size)})`);

            // Check if already uploaded in the versioned folder
            const existingFile = await findExistingFileInHamrahi(accessToken, versionFolderId, [fileName], REFRESH_TOKEN);
            let finalLink = null;
            let finalSizeBytes = asset.size;

            if (existingFile && existingFile.size > 1024) {
                console.log(`   ⚡ [CACHE HIT] File already exists on AbreHamrahi: ${existingFile.public_url}`);
                finalLink = existingFile.public_url;
                finalSizeBytes = existingFile.size;
            } else {
                // Download and Upload
                const localDest = path.join(DEST_DIR, fileName);
                try {
                    await downloadBinary(downloadUrl, localDest);
                    const st = fs.statSync(localDest);
                    finalSizeBytes = st.size;

                    console.log(`   ☁️ Uploading to AbreHamrahi ("${versionFolder}")...`);
                    const uploadResult = await uploadFileToHamrahi(
                        accessToken,
                        localDest,
                        versionFolderId,
                        fileName,
                        REFRESH_TOKEN
                    );

                    finalLink = uploadResult.public_url;
                    console.log(`   🎉 Upload complete: ${finalLink}`);
                } catch (err) {
                    console.error(`   ❌ Failed to download or upload ${fileName}: ${err.message}`);
                    continue;
                } finally {
                    if (fs.existsSync(localDest)) {
                        try { fs.unlinkSync(localDest); } catch {}
                    }
                }
            }

            // Report entry
            summaryReport.push({
                emulator: emu.name,
                version: release.tag,
                platform: platform,
                fileName: fileName,
                size: formatBytes(finalSizeBytes),
                url: finalLink
            });

            // Update website API if available
            try {
                await notifyWebsite({
                    emulator_slug: emu.slug,
                    version: release.tag,
                    platform: platform,
                    architecture: arch,
                    file_name: fileName,
                    file_size: formatBytes(finalSizeBytes),
                    file_size_bytes: finalSizeBytes,
                    download_url: finalLink
                });
            } catch {}
        }

        // Clean up previous versions from AbreHamrahi
        await cleanupOldVersionsInHamrahi(accessToken, baseFolderId, versionClean, REFRESH_TOKEN);
    }

    console.log('\n===========================================================');
    console.log('🎉 EMULATOR RELEASES SYNC COMPLETE');
    console.log('===========================================================');
    if (summaryReport.length > 0) {
        console.table(summaryReport.map(s => ({
            'شبیه‌ساز': s.emulator,
            'ورژن': s.version,
            'پلتفرم': s.platform,
            'نام فایل': s.fileName,
            'حجم': s.size,
            'لینک همراهی': s.url ? (s.url.substring(0, 45) + '...') : 'N/A'
        })));
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        let md = `### 🕹️ گزارش بررسی و دانلود جدیدترین نسخه‌های شبیه‌سازها\n\n`;
        md += `| شبیه‌ساز | نسخه | پلتفرم | فایل | حجم | لینک دانلود نیم‌بها |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
        for (const item of summaryReport) {
            md += `| **${item.emulator}** | \`${item.version}\` | \`${item.platform}\` | ${item.fileName} | ${item.size} | [دانلود](${item.url}) |\n`;
        }
        md += `\n*ورژن‌های قبلی شبیه‌سازها در ابر همراهی با موفقیت حذف شدند.*\n`;
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
