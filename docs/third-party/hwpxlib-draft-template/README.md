# Public development blank template

The bytes embedded in `src/engine/draft/template.ts` come from the unchanged
`testFile/tool/blank.hwpx` development fixture distributed by
[neolord0/hwpxlib](https://github.com/neolord0/hwpxlib) under the
[Apache License 2.0](LICENSE.txt).

- Source commit: `f9fd2255ac0fc57414e0b657d115e7de51d31c65`
- [Source fixture](https://github.com/neolord0/hwpxlib/blob/f9fd2255ac0fc57414e0b657d115e7de51d31c65/testFile/tool/blank.hwpx)
- [Source license](https://github.com/neolord0/hwpxlib/blob/f9fd2255ac0fc57414e0b657d115e7de51d31c65/license.txt)
- SHA-256: `d28f55cd622b6d0cade2d8ae3b5d53f1ed5c4154289e463a4c390d9be157aa6d`

The bundled `src/engine/draft/template.ts` contains these exact bytes as base64 so local draft
generation needs no template fetch. The generator creates a separate draft from
this template: it replaces the blank text and styles, removes the template's
line layout cache, and writes a stored first `mimetype` entry. It does not patch
or reconstruct an uploaded document. No private document is included here.

The generated draft's XML, references and text are tested locally. Opening and
rendering in Windows Hancom Hangul remain unverified until a manual record is
available. Naming a font in a draft does not verify that font is installed.

The distributed Pages app includes this attribution and a full Apache-2.0 license copy in `public/THIRD_PARTY_NOTICES.txt` (served as `THIRD_PARTY_NOTICES.txt`).
