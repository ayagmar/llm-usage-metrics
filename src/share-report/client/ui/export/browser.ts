// Browser side of export: reads a chart's computed styles, rasterises it and hands the file to
// the user. PNG goes SVG → blob URL → Image → canvas → PNG, the one path `img-src blob:`
// allows. The file layout and naming live in the pure modules next to this one.

import {
  EXPORT_STYLE_PROPERTIES,
  getExportFrame,
  getRasterSize,
  serializeSvgForExport,
  type ExportNode,
} from './svg-export.js';

const READ_PROPERTIES = [...EXPORT_STYLE_PROPERTIES, 'display', 'visibility'];

function readNode(element: Element): ExportNode {
  const style = getComputedStyle(element);

  return {
    tag: element.tagName,
    attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    computed: Object.fromEntries(
      READ_PROPERTIES.map((property) => [property, style.getPropertyValue(property)]),
    ),
    children: [...element.childNodes].flatMap((child): (ExportNode | string)[] => {
      if (child instanceof Element) {
        return [readNode(child)];
      }

      return child.nodeType === Node.TEXT_NODE ? [child.textContent ?? ''] : [];
    }),
  };
}

/** The chart as a standalone SVG file, on the background it sits on. */
export function exportSvg(svg: SVGSVGElement, backgroundOf: Element): string {
  return serializeSvgForExport(readNode(svg), getComputedStyle(backgroundOf).backgroundColor);
}

export async function renderPng(svg: SVGSVGElement, backgroundOf: Element): Promise<Blob> {
  const root = readNode(svg);
  const size = getExportFrame(root) ?? svg.getBoundingClientRect();
  const raster = getRasterSize({ width: size.width, height: size.height });
  const xml = serializeSvgForExport(root, getComputedStyle(backgroundOf).backgroundColor);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));

  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('this browser cannot draw on a canvas');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('PNG encoding failed'));
        }
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a file through a download link. */
export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** True when the browser can put an image on the clipboard. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== 'undefined' && 'clipboard' in navigator;
}

/**
 * Copies a PNG. A pending blob keeps Safari's user activation; older Chromium only takes a
 * resolved one, so a TypeError retries with the finished image.
 */
export async function copyPng(render: () => Promise<Blob>): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': render() })]);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await render() })]);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
