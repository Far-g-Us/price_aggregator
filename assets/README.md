# assets/

Исходники визуальных ассетов. Правило: правится SVG, растр — производная.

## icon.svg → build/icon.png + build/icon.ico

Иконка приложения (зелёный скруглённый квадрат + корзина + янтарная точка,
в цветах интерфейса). Рендер из корня проекта:

```
$env:PLAYWRIGHT_BROWSERS_PATH=".playwright-browsers"
node -e "import('playwright').then(async ({chromium}) => {
  const b = await chromium.launch();
  const p = await (await b.newContext({viewport:{width:1024,height:1024}})).newPage();
  await p.goto('file://$PWD/assets/icon.svg');
  await (await p.locator('svg')).screenshot({path: 'build/icon.png', omitBackground: true});
  await b.close();
})"
.\.venv\Scripts\python.exe -c "from PIL import Image; i=Image.open('build/icon.png'); i.save('build/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
```

Требует: `.venv` с `requirements.txt`, браузеры в `.playwright-browsers`.
`build/icon.ico` использует `electron-builder` (`win.icon`), `build/icon.png` — окно в dev-режиме.
Оба файла коммитятся.
