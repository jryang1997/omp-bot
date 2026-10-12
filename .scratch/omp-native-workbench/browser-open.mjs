const fs = await import('node:fs/promises');
const info = JSON.parse(await fs.readFile('C:/Users/Jerry/Desktop/omp_bot/.scratch/omp-native-workbench/ui-service.json', 'utf8'));
const space = await taskSpace(2);
const page = space.page('p1');
await page.goto(info.launchUrl);
await page.waitForFunction(() => document.querySelector('#conn-label')?.textContent === '已连接', undefined, { timeout: 15000 });
await fs.writeFile('C:/Users/Jerry/Desktop/omp_bot/.scratch/omp-native-workbench/browser-space.json', JSON.stringify({ spaceId: space.spaceId, page: 'p1' }));
console.log({ spaceId: space.spaceId });
console.log(await page.snapshot());
