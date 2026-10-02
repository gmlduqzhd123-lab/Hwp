import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';

// Public development inputs only. These are hand-assembled structural packages,
// not files exported or validated by Hancom Hangul.
const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures');
const namespaces = {
  section: 'http://www.hancom.co.kr/hwpml/2011/section',
  paragraph: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  head: 'http://www.hancom.co.kr/hwpml/2011/head',
  core: 'http://www.hancom.co.kr/hwpml/2011/core',
  version: 'http://www.hancom.co.kr/hwpml/2011/version',
  opf: 'http://www.idpf.org/2007/opf',
};
const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const paragraph = (prefix, id, text, charPrIDRef = '0') =>
  `<${prefix}:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><${prefix}:run charPrIDRef="${charPrIDRef}"><${prefix}:t>${escape(text)}</${prefix}:t></${prefix}:run></${prefix}:p>`;
const section = (body, alternate = false) => {
  const [sectionPrefix, paragraphPrefix, corePrefix] = alternate ? ['s', 'p', 'c'] : ['hs', 'hp', 'hc'];
  return `${declaration}<${sectionPrefix}:sec xmlns:${sectionPrefix}="${namespaces.section}" xmlns:${paragraphPrefix}="${namespaces.paragraph}" xmlns:${corePrefix}="${namespaces.core}">\n${body}\n</${sectionPrefix}:sec>\n`;
};
const header = (sectionCount, alternate) => {
  const prefix = alternate ? 'h' : 'hh';
  const fonts = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']
    .map((language) => `<${prefix}:fontface lang="${language}" fontCnt="1"><${prefix}:font id="0" face="함초롬바탕" type="TTF"/></${prefix}:fontface>`).join('');
  const charProperties = ['1100', '1200'].map((height, id) =>
    `<${prefix}:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0"><${prefix}:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/></${prefix}:charPr>`).join('');
  return `${declaration}<${prefix}:head xmlns:${prefix}="${namespaces.head}" version="1.5" secCnt="${sectionCount}"><${prefix}:refList><${prefix}:fontfaces itemCnt="7">${fonts}</${prefix}:fontfaces><${prefix}:charProperties itemCnt="2">${charProperties}</${prefix}:charProperties><${prefix}:paraProperties itemCnt="1"><${prefix}:paraPr id="0" tabPrIDRef="0"><${prefix}:align horizontal="JUSTIFY" vertical="BASELINE"/></${prefix}:paraPr></${prefix}:paraProperties></${prefix}:refList></${prefix}:head>\n`;
};
const tableCell = (id, text, row, column, { rowSpan = 1, columnSpan = 1, nested = '' } = {}) =>
  `<hp:tc borderFillIDRef="0"><hp:subList id="${id}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP">${paragraph('hp', id, text)}${nested}</hp:subList><hp:cellAddr colAddr="${column}" rowAddr="${row}"/><hp:cellSpan colSpan="${columnSpan}" rowSpan="${rowSpan}"/><hp:cellSz width="6000" height="3000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`;
const table = (id, rows, columnCount) =>
  `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${columnCount}" cellSpacing="0" borderFillIDRef="0"><hp:sz width="12000" height="6000" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>${rows.map((cells) => `<hp:tr>${cells.join('')}</hp:tr>`).join('')}</hp:tbl>`;
const objectParagraph = (id, object) => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${object}</hp:run></hp:p>`;

const specialText = '한글 공백  두 칸\t탭\n줄바꿈 & < > " \' © ∑ 😀';
const simpleTable = table('10', [
  [tableCell('11', '첫째 칸', 0, 0), tableCell('12', '둘째 칸', 0, 1)],
  [tableCell('13', '셋째 칸', 1, 0), tableCell('14', '넷째 칸', 1, 1)],
], 2);
const mergedTable = table('20', [
  [tableCell('21', '합쳐진 두 칸', 0, 0, { columnSpan: 2 })],
  [tableCell('22', '아래 왼쪽', 1, 0), tableCell('23', '아래 오른쪽', 1, 1)],
], 2);
const nestedTable = table('30', [[tableCell('31', '바깥 칸', 0, 0, {
  nested: objectParagraph('32', table('33', [[tableCell('34', '중첩된 칸', 0, 0)]], 1)),
})]], 1);

const definitions = [
  {
    id: '01-plain-text', description: '한글, 유니코드, 연속 공백, 탭, 줄바꿈과 XML 이스케이프 문자',
    sections: [section(`${paragraph('hp', '0', '합성 연구 보고서')}\n${paragraph('hp', '1', specialText, '1')}`)],
    sectionTexts: [['합성 연구 보고서', specialText]], spine: [0], tables: [],
  },
  {
    id: '02-alternate-prefixes', description: 'URI는 같고 section/paragraph/head/core/OPF prefix가 다른 문서',
    alternate: true, sections: [section(`${paragraph('p', '0', '다른 접두사에서도 한글 그대로')}\n${paragraph('p', '1', '기호 & 공백  보존')}`, true)],
    sectionTexts: [['다른 접두사에서도 한글 그대로', '기호 & 공백  보존']], spine: [0], tables: [],
  },
  {
    id: '03-spine-order', description: '물리적 파일명 순서 0,1,2와 선언된 문서 순서 2,0,1이 다름',
    sections: [section(paragraph('hp', '0', '선언 순서 두 번째')), section(paragraph('hp', '1', '선언 순서 세 번째')), section(paragraph('hp', '2', '선언 순서 첫 번째'))],
    sectionTexts: [['선언 순서 두 번째'], ['선언 순서 세 번째'], ['선언 순서 첫 번째']], spine: [2, 0, 1], tables: [],
  },
  {
    id: '04-simple-table', description: '병합과 중첩이 없는 합성 2행 2열 표',
    sections: [section(`${paragraph('hp', '0', '합성 단순 표')}\n${objectParagraph('1', simpleTable)}`)],
    sectionTexts: [['합성 단순 표', '첫째 칸', '둘째 칸', '셋째 칸', '넷째 칸']], spine: [0],
    tables: [{ id: '10', rows: 2, columns: 2, reason: 'UNVALIDATED_SYNTHETIC_PACKAGE' }],
  },
  {
    id: '05-unsupported-tables', description: '병합 표 및 중첩 표를 검사 전용으로 제한해야 하는 합성 사례',
    sections: [section(`${paragraph('hp', '0', '합성 미지원 표')}\n${objectParagraph('1', mergedTable)}\n${objectParagraph('2', nestedTable)}`)],
    sectionTexts: [['합성 미지원 표', '합쳐진 두 칸', '아래 왼쪽', '아래 오른쪽', '바깥 칸', '중첩된 칸']], spine: [0],
    tables: [
      { id: '20', rows: 2, columns: 2, reason: 'MERGED_TABLE' },
      { id: '30', rows: 1, columns: 1, reason: 'NESTED_TABLE' },
      { id: '33', rows: 1, columns: 1, reason: 'NESTED_TABLE' },
    ],
  },
];

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(outputDirectory, { recursive: true });
for (const definition of definitions) {
  const prefix = definition.alternate ? 'o' : 'opf';
  const sectionPaths = definition.sections.map((_, index) => `Contents/section${index}.xml`);
  const manifest = `<${prefix}:item id="header" href="header.xml" media-type="application/xml"/>${sectionPaths.map((_, index) => `<${prefix}:item id="section${index}" href="section${index}.xml" media-type="application/xml"/>`).join('')}`;
  const spine = definition.spine.map((index) => `<${prefix}:itemref idref="section${index}" linear="yes"/>`).join('');
  const entries = [
    ['mimetype', 'application/hwp+zip'],
    ['version.xml', `${declaration}<hv:HCFVersion xmlns:hv="${namespaces.version}" targetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="0" os="1" xmlVersion="1.5" application="synthetic-fixture" appVersion="0"/>\n`],
    ['META-INF/container.xml', `${declaration}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>\n`],
    ['Contents/content.hpf', `${declaration}<${prefix}:package xmlns:${prefix}="${namespaces.opf}" version="3.0" unique-identifier="synthetic-id"><${prefix}:metadata><${prefix}:title>공개 합성 fixture</${prefix}:title></${prefix}:metadata><${prefix}:manifest>${manifest}</${prefix}:manifest><${prefix}:spine>${spine}</${prefix}:spine></${prefix}:package>\n`],
    ['Contents/header.xml', header(definition.sections.length, definition.alternate)],
    ...definition.sections.map((xml, index) => [sectionPaths[index], xml]),
  ];
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false, useCompressionStream: false, extendedTimestamp: false,
    zip64: false, dataDescriptor: false, msDosCompatible: true,
  });
  for (const [name, contents] of entries) {
    // A local wall-clock date fixes DOS timestamp fields across host time zones.
    // Store all these small fixtures to make their bytes independent of codecs.
    await writer.add(name, new TextReader(contents), { level: 0, lastModDate: new Date(2024, 0, 1, 0, 0, 0) });
  }
  const bytes = await writer.close();
  const golden = {
    fixtureId: definition.id, description: definition.description, synthetic: true,
    hancomValidation: { status: 'NOT_RUN', build: null, rendering: 'NOT_VALIDATED' },
    expectedSupportLevel: 'INSPECT_ONLY', supportReason: 'UNVALIDATED_SYNTHETIC_PACKAGE',
    packageVersion: { major: 5, minor: 1, micro: 0, buildNumber: 0, xmlVersion: '1.5' },
    mimetype: { value: 'application/hwp+zip', entryIndex: 0, compressionMethod: 0 },
    packageEntry: 'Contents/content.hpf', entryNames: entries.map(([name]) => name),
    declaredSectionOrder: definition.spine.map((index) => sectionPaths[index]),
    paragraphsInDeclaredOrder: definition.spine.flatMap((index) => definition.sectionTexts[index]),
    sections: sectionPaths.map((entryPath, index) => ({ entryPath, texts: definition.sectionTexts[index] })),
    tables: definition.tables.map((item) => ({ ...item, supportLevel: 'INSPECT_ONLY' })),
    formatCandidates: { characterShapes: [{ id: '0', height: 1100 }, { id: '1', height: 1200 }], fontReference: 'existing-language-font-id-0', cachePolicy: 'UNVALIDATED_NO_EDIT' },
    packageByteLength: bytes.length, packageSha256: hash(bytes),
    entrySha256: Object.fromEntries(entries.map(([name, contents]) => [name, hash(Buffer.from(contents, 'utf8'))])),
  };
  await writeFile(resolve(outputDirectory, `${definition.id}.hwpx`), bytes);
  await writeFile(resolve(outputDirectory, `${definition.id}.golden.json`), `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`Generated ${definition.id}.hwpx (${bytes.length} bytes)`);
}
