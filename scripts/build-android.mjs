import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = process.env.OMPBOT_ANDROID_TOOLCHAIN || join(homedir(), '.cache', 'omp-bot-android');
let toolchain = {};
try { toolchain = JSON.parse(await readFile(join(cache, 'toolchain.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const javaHome = process.env.JAVA_HOME || toolchain.javaHome;
const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || toolchain.sdkRoot;
if (!javaHome || !sdkRoot) throw new Error('Configure JAVA_HOME and ANDROID_HOME, or provision the portable omp-bot Android toolchain.');
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot, PATH: join(javaHome, 'bin') + delimiter + (process.env.PATH || '') };
const debug = process.argv.includes('--debug');
const run = (binary, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, env, windowsHide: true, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...options });
  let output = '';
  if (options.capture) child.stdout.on('data', (part) => { output += part; });
  child.once('error', reject);
  child.once('close', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${binary} failed (${code ?? signal}).`)));
});
const project = join(root, 'android');
const wrapper = process.platform === 'win32' ? join(project, 'gradlew.bat') : join(project, 'gradlew');
if (!existsSync(wrapper)) throw new Error('Android Gradle wrapper is missing.');
if (!debug) {
  await Promise.all(['app-release.apk', 'app-release-unsigned.apk'].map(file => rm(join(project, 'app', 'build', 'outputs', 'apk', 'release', file), { force: true })));
}
const tasks = [':core:test', ':app:testDebugUnitTest', debug ? ':app:assembleDebug' : ':app:assembleRelease', '--no-daemon', '--console=plain'];
await run(join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-classpath', join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', ...tasks], { cwd: project });
const release = join(root, 'release');
await mkdir(release, { recursive: true });
const destination = join(release, debug ? 'omp-bot-android-debug.apk' : 'omp-bot-android.apk');
const buildTools = join(sdkRoot, 'build-tools', '36.0.0');
const configuredRelease = join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (debug) {
  await copyFile(join(project, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), destination);
} else if (existsSync(configuredRelease)) {
  await copyFile(configuredRelease, destination);
} else {
  const signingFile = join(cache, 'signing.json');
  let signing;
  try { signing = JSON.parse(await readFile(signingFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(cache, { recursive: true });
    const keystore = join(cache, 'omp-bot-release.p12');
    if (existsSync(keystore)) throw new Error('Signing keystore exists without its signing.json. Restore the matching signing record before building.');
    signing = { keystore, alias: 'omp-bot', password: randomBytes(32).toString('base64url') };
    env.OMPBOT_ANDROID_STOREPASS = signing.password;
    await run(join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-storetype', 'PKCS12', '-keystore', keystore, '-alias', signing.alias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-dname', 'CN=OMP Bot, O=OMP Bot, C=CN', '-storepass:env', 'OMPBOT_ANDROID_STOREPASS', '-keypass:env', 'OMPBOT_ANDROID_STOREPASS']);
    await writeFile(signingFile, JSON.stringify(signing), { mode: 0o600, flag: 'wx' });
  }
  env.OMPBOT_ANDROID_STOREPASS = signing.password;
  const unsigned = join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
  const signer = join(buildTools, 'lib', 'apksigner.jar');
  const signArgs = ['sign', '--ks', signing.keystore, '--ks-key-alias', signing.alias, '--ks-pass', 'env:OMPBOT_ANDROID_STOREPASS', '--key-pass', 'env:OMPBOT_ANDROID_STOREPASS', '--out', destination, unsigned];
  await run(join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-jar', signer, ...signArgs]);
}
const jar = join(buildTools, 'lib', 'apksigner.jar');
const verification = await run(join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-jar', jar, 'verify', '--verbose', '--print-certs', destination], { capture: true });
console.log(verification.trim());
const badging = await run(join(buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', destination], { capture: true });
const identity = /package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/.exec(badging);
if (!identity || identity[1] !== 'org.ompbot.companion') throw new Error('Built APK has an unexpected Android identity.');
const bytes = await readFile(destination);
const manifest = { packageName: identity[1], versionCode: Number(identity[2]), version: identity[3], file: destination.split(/[\\/]/).at(-1), size: (await stat(destination)).size, sha256: createHash('sha256').update(bytes).digest('hex'), signing: debug ? 'debug' : existsSync(configuredRelease) ? 'configured-release' : 'local-release', signingCertificateSha256: /Signer #1 certificate SHA-256 digest: (\S+)/.exec(verification)?.[1] ?? null };
await writeFile(join(dirname(destination), debug ? 'omp-bot-android-debug.json' : 'omp-bot-android.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
