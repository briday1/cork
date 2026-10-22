# Assets

## Real cork photograph

`cork-fine.webp` is an optimized copy of the real cork / notice board photograph [PxHere photo 974274](https://pxhere.com/en/photo/974274). The source lists Samsung GT-S7580 camera metadata and dedicates the photograph to the [Creative Commons CC0 1.0 public domain](https://creativecommons.org/publicdomain/zero/1.0/).

Original: 2048 × 1536 JPEG. Bundled web asset: 2048 × 1536 WebP, quality 86, with metadata removed. It is served locally as part of Cork. Neighboring tiles mirror the same photograph at their edges to keep an unlimited surface continuous. The cork uses the same world transform as the notes, so its grain moves and scales with them. Pale and dark appearances apply CSS color adjustments to the same photo.

## Cursors

`grab.svg` and `grabbing.svg` are original vector cursor artwork. The SVG sources are accompanied by 2× and 3× PNG renderings selected with CSS image-set so high-density displays do not upscale a small cursor bitmap. CSS supplies the platform hand cursor as a fallback.

## PDF export

PDF export loads two bundled libraries only when requested. Neither contacts a third-party server:

- [html-to-image 1.11.13](https://github.com/bubkoo/html-to-image/tree/v1.11.13), bundled from its npm package as an ES module; MIT license in `html-to-image.LICENSE.txt`.
- [pdf-lib 1.17.1](https://github.com/Hopding/pdf-lib/tree/v1.17.1), the package’s minified ES module; MIT license in `pdf-lib.LICENSE.txt`.

Notes are captured individually as lossless 4× PNGs (384 dpi at the original paper size), then placed with their original positions and rotation on an unpainted PDF page. Very large individual notes use a lower capture scale to stay within browser canvas memory limits. The PDF is image-based; text is not selectable. Cork, controls, selection outlines, and drop shadows are omitted.
