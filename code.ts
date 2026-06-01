/// <reference types="@figma/plugin-typings" />

const LINE_SNAP_RANGE_PX = 80;
const PUSH_TO_NEXT_PAGE_RANGE_PX = 300; // how far above the cut to look for an element top to push whole element to next page
const PREVIEW_GROUP_NAME = 'SliceExport Preview';

// Page outline colours — alternating so adjacent pages are visually distinct
const PREVIEW_COLORS: RGB[] = [
  { r: 1,    g: 0.231, b: 0.188 }, // #FF3B30 red
  { r: 0,    g: 0.478, b: 1     }, // #007AFF blue
];

figma.showUI(__html__, { width: 300, height: 460 });

let selectedFrame: FrameNode | null = null;

const getY = (n: SceneNode): number => ('y' in n ? (n as any).y as number : 0);
const getH = (n: SceneNode): number => ('height' in n ? (n as any).height as number : 0);

function collectCutCandidates(
  node: SceneNode,
  targetY: number,
  nodeTopInFrame: number
): number[] {
  const bottom = nodeTopInFrame + getH(node);
  if (nodeTopInFrame > targetY || bottom < targetY - LINE_SNAP_RANGE_PX) return [];

  const results: number[] = [];

  // If this node's bottom edge falls within the snap window, treat it as an
  // atomic cut boundary — snap here and stop. Never recurse into children when
  // the container itself is already a clean cut point; doing so would let the
  // algorithm find elements inside nested frames (phone mockups, image blocks)
  // and produce inconsistent results.
  //
  // NOTE: getRangeBoundingBoxes (undocumented runtime API) was previously used
  // here to snap to individual text lines, but it is font-load-state-dependent:
  // it returns different results before vs after figma.loadFontAsync() is called,
  // making cut positions non-deterministic between the first preview run and all
  // subsequent runs/exports. Element-boundary snapping is fully deterministic
  // because it only reads .y and .height which are stable layout properties.
  if (bottom <= targetY && bottom >= targetY - LINE_SNAP_RANGE_PX) {
    results.push(bottom);
    return results;
  }

  // Node spans the cut target: recurse into children to find a tighter boundary.
  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) {
      results.push(...collectCutCandidates(child, targetY, nodeTopInFrame + getY(child)));
    }
  }
  return results;
}

function findSafeCutY(frame: FrameNode, targetY: number): number {
  if (targetY >= frame.height) return frame.height;

  // Pass 1: snap to the bottom of an element just above targetY (avoids mid-element cuts)
  const candidates: number[] = [];
  for (const child of frame.children) {
    candidates.push(...collectCutCandidates(child, targetY, getY(child)));
  }
  if (candidates.length) return Math.max(...candidates);

  // Pass 2: no bottom-snap found — find an element that SPANS the cut line
  // with actual content being cut (not blank space inside a container), and
  // snap to its top so the whole element moves to the next page.
  // Important: only snap when a CHILD of the container also spans the cut —
  // if no child spans it the cut is in blank space inside the container,
  // which is fine to cut through.
  let bestTop = -1;
  function findSpanningTop(node: SceneNode, absY: number): void {
    const bottom = absY + getH(node);
    if (absY >= targetY || bottom <= targetY) return; // doesn't span cut

    if ('children' in node && (node as ChildrenMixin).children.length > 0) {
      // Check whether any child also spans the cut (= real content being cut)
      let childSpansCut = false;
      for (const child of (node as ChildrenMixin).children) {
        const cY = absY + getY(child);
        if (cY < targetY && cY + getH(child) > targetY) { childSpansCut = true; break; }
      }

      if (!childSpansCut) return; // cut is in blank space inside this container — ignore

      if (absY >= targetY - PUSH_TO_NEXT_PAGE_RANGE_PX) {
        // Container has real content being cut and is close enough — snap to its top
        if (absY > bestTop) bestTop = absY;
        return;
      }
      // Container is too tall; recurse to find a tighter child boundary
      for (const child of (node as ChildrenMixin).children) {
        findSpanningTop(child, absY + getY(child));
      }
    } else {
      // Leaf node (image, text, shape) spans the cut
      if (absY >= targetY - PUSH_TO_NEXT_PAGE_RANGE_PX && absY > bestTop) {
        bestTop = absY;
      }
    }
  }
  for (const child of frame.children) {
    findSpanningTop(child, getY(child));
  }
  if (bestTop > 0) return bestTop;

  return targetY;
}

// Returns the absolute Y where the next slice should start.
// Skips inter-section whitespace (gap between elements) so it falls at the
// bottom of the previous page. But if fromY lands INSIDE an element (i.e.
// the cut went through it), returns fromY unchanged so the element is not
// skipped entirely.
function findContentStartY(frame: FrameNode, fromY: number): number {
  let earliest = Infinity;
  let spanned = false;

  function search(node: SceneNode, absY: number): void {
    if (spanned) return;
    const bottom = absY + getH(node);
    if (bottom <= fromY) return; // entirely before cut, skip

    if (absY >= fromY) {
      if (absY < earliest) earliest = absY;
      return;
    }

    // Node spans the cut (absY < fromY < bottom)
    if ('children' in node && (node as ChildrenMixin).children.length > 0) {
      // Container — recurse to find finer boundaries inside it
      for (const child of (node as ChildrenMixin).children) {
        search(child, absY + getY(child));
      }
    } else {
      // Leaf node (text, image, shape) spans the cut — content is here, don't skip
      spanned = true;
    }
  }

  for (const child of frame.children) {
    search(child, getY(child));
    if (spanned) break;
  }

  if (spanned) return fromY;
  return earliest === Infinity ? fromY : earliest;
}

function computeSlices(frame: FrameNode, contentHeightPx: number): Array<{ startY: number; endY: number }> {
  const slices: Array<{ startY: number; endY: number }> = [];
  let scanY = 0;
  while (scanY < frame.height) {
    const sliceStartY = scanY;
    const rawEnd = sliceStartY + contentHeightPx;
    if (rawEnd >= frame.height) { slices.push({ startY: sliceStartY, endY: Math.round(frame.height) }); break; }
    const safeEnd = findSafeCutY(frame, rawEnd);
    const endY = safeEnd > sliceStartY + contentHeightPx * 0.1 ? safeEnd : rawEnd;
    const endYInt = Math.round(endY);
    slices.push({ startY: sliceStartY, endY: endYInt });
    // Advance past any inter-section whitespace so it falls at the bottom of
    // the current page rather than the top of the next one.
    scanY = findContentStartY(frame, endYInt);
    if (slices.length > 2000) break;
  }
  return slices;
}

function clearPreviewGroup(): void {
  // Remove the named group (normal case) and any orphaned individual nodes
  // that were left behind if a previous figma.group() call failed mid-run.
  figma.currentPage.findAll(n =>
    n.name === PREVIEW_GROUP_NAME ||
    n.name.startsWith('SliceExport_Page_') ||
    n.name.startsWith('SliceExport_Label_')
  ).forEach(n => n.remove());
}

figma.ui.onmessage = async (msg) => {
  // --- ready ---
  if (msg.type === 'ready') {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1 || sel[0].type !== 'FRAME') {
      figma.ui.postMessage({
        type: 'error',
        message:
          sel.length === 0
            ? 'No frame selected. Select a single frame and reopen the plugin.'
            : sel.length > 1
              ? 'Multiple items selected. Select exactly one frame.'
              : 'Selected item is not a frame. Select a frame node.',
      });
      return;
    }
    selectedFrame = sel[0] as FrameNode;
    figma.ui.postMessage({
      type: 'frame-info',
      name: selectedFrame.name,
      width: Math.round(selectedFrame.width),
      height: Math.round(selectedFrame.height),
    });
    return;
  }

  // --- preview-cuts ---
  if (msg.type === 'preview-cuts') {
    if (!selectedFrame) {
      figma.ui.postMessage({ type: 'error', message: 'No frame available. Reopen the plugin.' });
      return;
    }

    const { marginTopMm, marginBottomMm } = msg as { marginTopMm: number; marginBottomMm: number };

    // Snapshot dimensions once — read before any async work so a concurrent
    // message or a font-triggered relayout cannot shift the values mid-handler.
    const frameWidth  = selectedFrame.width;
    const frameHeight = selectedFrame.height;
    const frameX      = selectedFrame.x;
    const frameY      = selectedFrame.y;

    const contentHeightMm = 297 - marginTopMm - marginBottomMm;
    const contentHeightPx = contentHeightMm * (frameWidth / 210);

    if (contentHeightPx <= 0) {
      figma.ui.postMessage({ type: 'error', message: 'Margins exceed page height.' });
      return;
    }

    clearPreviewGroup();

    // Load font BEFORE computing cut points.  If loadFontAsync triggers any
    // auto-layout recompute inside the frame, the positions we read in
    // computeCutPoints will reflect the settled state, which is the same state
    // the rectangles will be drawn against.  Doing it the other way around
    // (cuts computed pre-load, rects drawn post-load) caused the first preview
    // to show different page heights than every subsequent run.
    try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); } catch (_) {}

    const sliceDefs = computeSlices(selectedFrame, contentHeightPx);
    const pageCount  = sliceDefs.length;
    const labelSize  = Math.max(14, Math.round(frameWidth * 0.018));

    const nodes: SceneNode[] = [];

    for (let i = 0; i < pageCount; i++) {
      const { startY: sliceStartY, endY: sliceEndY } = sliceDefs[i];
      const sliceH    = Math.max(1, sliceEndY - sliceStartY);
      const color     = PREVIEW_COLORS[i % PREVIEW_COLORS.length];

      // Page boundary rectangle — outline only, no fill
      const rect = figma.createRectangle();
      rect.x = frameX;
      rect.y = frameY + sliceStartY;
      rect.resize(frameWidth, sliceH);
      rect.fills   = [];
      rect.strokes = [{ type: 'SOLID', color }];
      rect.strokeWeight = 2;
      rect.strokeAlign  = 'OUTSIDE';
      rect.name = `SliceExport_Page_${i + 1}`;
      figma.currentPage.appendChild(rect);
      nodes.push(rect);

      // Page number label to the right of the frame
      try {
        const label = figma.createText();
        label.fontName   = { family: 'Inter', style: 'Regular' };
        label.fontSize   = labelSize;
        label.characters = `${i + 1}`;
        label.fills = [{ type: 'SOLID', color }];
        label.x = frameX + frameWidth + 12;
        label.y = frameY + sliceStartY + 8;
        label.name = `SliceExport_Label_${i + 1}`;
        figma.currentPage.appendChild(label);
        nodes.push(label);
      } catch (_) { /* font unavailable — skip label */ }

    }

    if (nodes.length > 0) {
      try {
        const group = figma.group(nodes, figma.currentPage);
        group.name = PREVIEW_GROUP_NAME;
      } catch (_) {
        // figma.group() can throw if a node was silently reparented elsewhere.
        // Clean up individual nodes so nothing is left inside the frame.
        nodes.forEach(n => { try { n.remove(); } catch (_2) {} });
      }
    }

    figma.viewport.scrollAndZoomIntoView([selectedFrame]);
    figma.ui.postMessage({ type: 'preview-done', pageCount });
    return;
  }

  // --- clear-preview ---
  if (msg.type === 'clear-preview') {
    clearPreviewGroup();
    figma.ui.postMessage({ type: 'preview-cleared' });
    return;
  }

  // --- start-export ---
  if (msg.type === 'start-export') {
    if (!selectedFrame) {
      figma.ui.postMessage({ type: 'error', message: 'No frame available. Reopen the plugin.' });
      return;
    }

    // Remove any preview overlays so they don't appear in slice exports
    clearPreviewGroup();

    const { marginTopMm, marginBottomMm, scale: rawScale } = msg as {
      marginTopMm: number;
      marginBottomMm: number;
      scale?: number;
    };
    // Clamp scale to 2–4; default to 3 if not provided
    const exportScale = Math.min(4, Math.max(2, rawScale ?? 3));

    const frameHeight = selectedFrame.height;
    const frameWidth = selectedFrame.width;
    const contentHeightMm = 297 - marginTopMm - marginBottomMm;
    const contentHeightPx = contentHeightMm * (frameWidth / 210);

    if (contentHeightPx <= 0) {
      figma.ui.postMessage({ type: 'error', message: 'Margins exceed page height.' });
      return;
    }

    const sliceDefs = computeSlices(selectedFrame, contentHeightPx);
    const pageCount = sliceDefs.length;

    for (let i = 0; i < pageCount; i++) {
      const { startY: sliceStartY, endY: sliceEndY } = sliceDefs[i];
      const sliceHeightPx = Math.max(1, sliceEndY - sliceStartY);

      const slice = figma.createSlice();
      slice.x = selectedFrame.x;
      slice.y = selectedFrame.y + sliceStartY;
      slice.resize(frameWidth, sliceHeightPx);
      figma.currentPage.appendChild(slice);

      let bytes: Uint8Array;
      try {
        bytes = await slice.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: exportScale },
          colorProfile: 'SRGB', // force sRGB so jsPDF never sees an embedded P3 profile
        });
      } catch (err) {
        slice.remove();
        figma.ui.postMessage({
          type: 'error',
          message: `Export failed on page ${i + 1}: ${(err as Error).message}`,
        });
        return;
      }

      slice.remove();

      figma.ui.postMessage({
        type: 'slice-ready',
        index: i,
        total: pageCount,
        bytes,
        isLast: i === pageCount - 1,
        sliceHeightPx,
        contentHeightPx,
      });

    }
    return;
  }

  // --- close ---
  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
