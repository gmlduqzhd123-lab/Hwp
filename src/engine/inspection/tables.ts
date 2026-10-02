import type { InspectionCell, InspectionReason, InspectionRow, InspectionTable } from '../../domain/document';
import { elementChildren, type XmlIndex, type XmlIndexedElement } from '../xml/index';
import { ancestor, INSPECTION_NAMESPACES as NS, isElement, type NodeCatalog, uniqueReasons } from './nodes';

function integer(value: string | undefined, minimum: number): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function hasUnknownNamespace(element: XmlIndexedElement): boolean {
  const stack = [element];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (current.uri !== NS.paragraph && current.uri !== NS.core) return true;
    for (const child of current.children) if (child.kind === 'element') stack.push(child);
  }
  return false;
}

/** No grid is allocated from document-declared row/column/span values. */
export function inspectTables(index: XmlIndex, nodes: NodeCatalog, sectionId: string) {
  const tables: InspectionTable[] = [];
  const rows: InspectionRow[] = [];
  const cells: InspectionCell[] = [];
  const tablesByElement = new Map<XmlIndexedElement, InspectionTable>();
  const cellsByElement = new Map<XmlIndexedElement, InspectionCell>();
  const tableElements = index.elements.filter((element) => isElement(element, NS.paragraph, 'tbl'));
  const tableElementSet = new Set(tableElements);
  const nestedTables = new Set<XmlIndexedElement>();
  for (const element of tableElements) {
    const parent = ancestor(element, (candidate) => tableElementSet.has(candidate));
    if (parent) { nestedTables.add(element); nestedTables.add(parent); }
  }
  for (const element of tableElements) {
    const ownRows: InspectionRow[] = [];
    const ownCells: InspectionCell[] = [];
    const ownCellsById = new Map<string, InspectionCell>();
    const reasons: InspectionReason[] = [];
    const rowCount = integer(element.attributes.rowCnt, 1);
    const columnCount = integer(element.attributes.colCnt, 1);
    if (rowCount === null || columnCount === null) reasons.push('INVALID_TABLE_STRUCTURE');
    if (nestedTables.has(element)) reasons.push('NESTED_TABLE');
    if (hasUnknownNamespace(element)) reasons.push('UNKNOWN_NAMESPACE');
    const known = new Set(['sz', 'pos', 'outMargin', 'inMargin', 'tr', 'shapeComment']);
    if (elementChildren(element).some((child) => child.uri !== NS.paragraph || !known.has(child.local))) reasons.push('UNKNOWN_ELEMENT');
    const parentElement = ancestor(element, (candidate) => tableElementSet.has(candidate));
    const table: InspectionTable = {
      ...nodes.identity(element), sectionId,
      parentTableId: parentElement ? nodes.identity(parentElement).nodeId : null,
      rows: rowCount, columns: columnCount, rowIds: [], cellIds: [], paragraphIds: [],
    };
    tables.push(table);
    tablesByElement.set(element, table);
    const tableRows = elementChildren(element, NS.paragraph, 'tr');
    if (rowCount !== tableRows.length) reasons.push('INVALID_TABLE_STRUCTURE');
    const addresses = new Set<string>();
    for (const [rowOrder, rowElement] of tableRows.entries()) {
      const row: InspectionRow = { ...nodes.identity(rowElement), tableId: table.nodeId, order: rowOrder, cellIds: [] };
      rows.push(row);
      ownRows.push(row);
      table.rowIds.push(row.nodeId);
      const cellElements = elementChildren(rowElement, NS.paragraph, 'tc');
      if (elementChildren(rowElement).length !== cellElements.length) reasons.push('INVALID_TABLE_STRUCTURE');
      for (const cellElement of cellElements) {
        const cellReasons: InspectionReason[] = [];
        const addressElements = elementChildren(cellElement, NS.paragraph, 'cellAddr');
        const spanElements = elementChildren(cellElement, NS.paragraph, 'cellSpan');
        const address = addressElements[0];
        const span = spanElements[0];
        const rowAddress = integer(address?.attributes.rowAddr, 0);
        const columnAddress = integer(address?.attributes.colAddr, 0);
        const rowSpan = integer(span?.attributes.rowSpan, 1);
        const columnSpan = integer(span?.attributes.colSpan, 1);
        if (addressElements.length !== 1 || spanElements.length !== 1 || rowAddress === null || columnAddress === null || rowSpan === null || columnSpan === null
          || rowAddress !== rowOrder || (rowCount !== null && rowAddress + rowSpan > rowCount)
          || (columnCount !== null && columnAddress + columnSpan > columnCount)) cellReasons.push('INVALID_TABLE_STRUCTURE');
        if ((rowSpan !== null && rowSpan > 1) || (columnSpan !== null && columnSpan > 1)) cellReasons.push('MERGED_TABLE');
        const key = `${rowAddress}:${columnAddress}`;
        if (addresses.has(key)) cellReasons.push('INVALID_TABLE_STRUCTURE');
        addresses.add(key);
        const lists = elementChildren(cellElement, NS.paragraph, 'subList');
        if (lists.length !== 1) cellReasons.push('INVALID_TABLE_STRUCTURE');
        if (lists.some((list) => elementChildren(list).some((child) => !isElement(child, NS.paragraph, 'p')))) cellReasons.push('UNKNOWN_ELEMENT');
        const knownCell = new Set(['subList', 'cellAddr', 'cellSpan', 'cellSz', 'cellMargin']);
        if (elementChildren(cellElement).some((child) => child.uri !== NS.paragraph || !knownCell.has(child.local))) cellReasons.push('UNKNOWN_ELEMENT');
        const cell: InspectionCell = {
          ...nodes.identity(cellElement), tableId: table.nodeId, rowId: row.nodeId,
          rowAddress, columnAddress, rowSpan, columnSpan, paragraphIds: [], text: '',
          reasons: uniqueReasons(cellReasons),
        };
        cells.push(cell);
        ownCells.push(cell);
        ownCellsById.set(cell.nodeId, cell);
        cellsByElement.set(cellElement, cell);
        row.cellIds.push(cell.nodeId);
        table.cellIds.push(cell.nodeId);
        reasons.push(...cellReasons);
      }
    }
    // For the only candidate shape (unmerged), require the entire exact grid in
    // source order. Unsupported merged shapes still retain every original cell.
    if (!reasons.includes('MERGED_TABLE') && columnCount !== null) {
      for (const row of ownRows) {
        if (row.cellIds.length !== columnCount) reasons.push('INVALID_TABLE_STRUCTURE');
        for (const [columnOrder, id] of row.cellIds.entries()) {
          const cell = ownCellsById.get(id);
          if (cell?.columnAddress !== columnOrder) reasons.push('INVALID_TABLE_STRUCTURE');
        }
      }
    }
    table.reasons = uniqueReasons(reasons);
    for (const row of ownRows) row.reasons = [...table.reasons];
    for (const cell of ownCells) cell.reasons = uniqueReasons([...cell.reasons, ...table.reasons]);
  }
  return { tables, rows, cells, tablesByElement, cellsByElement };
}
