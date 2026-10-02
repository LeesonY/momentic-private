import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { containedKinds, redactText, redactUrl } from "./redact.mjs";

const NEEDED_DEFS = ["BrowserSnapshot", "SnapshotNode", "Bounds", "NetworkEntries", "NetworkEntry"];

export function fingerprint(parts) {
  const lines = parts
    .map((part) => `${part.stableFrame}|${part.role}|${part.name}|${part.text}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function collectNodes(page) {
  const frames = page.frames();
  const frameIds = [];
  const nodes = [];
  const excluded = [];
  const omissions = [];

  for (const frame of frames) {
    const frameId = randomUUID();
    frameIds.push(frameId);
    const stableFrame = frame === page.mainFrame() ? "main" : framePath(frame);
    let inspected;
    try {
      inspected = await frame.evaluate(inspectFrame);
    } catch (error) {
      excluded.push({
        stableFrame,
        reason: "frame-inaccessible",
        message: redactText(error.message).slice(0, 300),
      });
      continue;
    }
    inspected.forEach((item, index) => {
      if (item.sensitive) {
        omissions.push({ domId: item.domId, type: item.type, visible: item.visible });
      }
      if (!item.visible || (item.sensitive && item.type === "hidden")) {
        excluded.push({
          domId: item.domId,
          stableFrame,
          role: item.role,
          reason: item.sensitive ? "sensitive-or-hidden" : "not-visible",
        });
        return;
      }
      const nodeId = `${stableFrame}/${item.domId || `el-${index}`}`.slice(0, 120);
      const name = redactText(item.name).slice(0, 1000);
      const text = redactText(item.text).slice(0, 2000);
      nodes.push({
        nodeId,
        frameId,
        role: item.role,
        name,
        text,
        visible: true,
        enabled: item.enabled,
        bounds: { left: 0, top: 0, width: 0, height: 0 },
        domId: item.domId,
        stableFrame,
      });
    });
  }

  for (const node of nodes) {
    if (!node.domId || !/^[A-Za-z][\w-]*$/.test(node.domId)) continue;
    const frame = frames.find((item) => (item === page.mainFrame() ? "main" : framePath(item)) === node.stableFrame);
    if (!frame) continue;
    const box = await frame.locator(`#${node.domId}`).boundingBox();
    if (!box) {
      node.visible = false;
      continue;
    }
    node.bounds = { left: box.x, top: box.y, width: box.width, height: box.height };
  }

  const visibleNodes = [];
  const parts = [];
  for (const node of nodes) {
    if (!node.visible) {
      excluded.push({ domId: node.domId, stableFrame: node.stableFrame, role: node.role, reason: "no-box" });
      continue;
    }
    parts.push({ stableFrame: node.stableFrame, role: node.role, name: node.name, text: node.text });
    const { domId, stableFrame, ...contract } = node;
    visibleNodes.push(contract);
  }

  return { frameIds, nodes: visibleNodes, parts, excluded, omissions };
}

function framePath(frame) {
  try {
    return new URL(frame.url()).pathname || "frame";
  } catch {
    return "frame";
  }
}

function inspectFrame() {
  const selected = document.querySelectorAll("h1, p, button, input, iframe, [role]");
  const seen = new Set();
  const items = [];
  for (const el of selected) {
    if (seen.has(el)) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const sensitive = tag === "input" && (type === "hidden" || type === "password");
    const style = getComputedStyle(el);
    const typeHidden = tag === "input" && type === "hidden";
    const visible = !typeHidden
      && !el.hasAttribute("hidden")
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && el.getClientRects().length > 0;
    items.push({
      domId: el.id || "",
      tag,
      type,
      role: roleOf(el, tag, type),
      name: nameOf(el, tag, type),
      text: tag === "input" || tag === "textarea" ? "" : (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 500),
      visible,
      enabled: !el.matches(":disabled"),
      sensitive,
    });
  }
  return items;

  function roleOf(el, tag, type) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea") return type === "hidden" ? "hidden-input" : "textbox";
    if (tag === "h1") return "heading";
    if (tag === "iframe") return "iframe";
    if (tag === "p") return "paragraph";
    return tag;
  }

  function nameOf(el, tag, type) {
    if (tag === "iframe") return (el.getAttribute("title") || "").trim().slice(0, 200);
    if (tag === "input" || tag === "textarea") {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return (el.getAttribute("aria-label") || (label ? label.textContent : "") || "").trim().slice(0, 200);
    }
    const labelled = el.getAttribute("aria-label");
    if (labelled) return labelled.trim().slice(0, 200);
    return (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200);
  }
}

export function assembleSnapshot(fields) {
  return {
    snapshotId: fields.snapshotId,
    pageId: fields.pageId,
    frameIds: fields.frameIds,
    displayUrl: fields.displayUrl,
    title: fields.title.slice(0, 500),
    responseStatus: fields.responseStatus,
    capturedAt: new Date().toISOString(),
    stateVersion: fields.stateVersion,
    viewport: fields.viewport,
    nodes: fields.nodes,
    screenshotRef: fields.screenshotRef,
    networkSummary: fields.networkSummary.slice(0, 100),
    consoleSummary: fields.consoleSummary.slice(0, 50).map((line) => line.slice(0, 1000)),
    truncated: fields.nodes.length > 1000 || fields.networkSummary.length > 100 || fields.consoleSummary.length > 50,
    redacted: true,
  };
}

export function extraInvariants(snapshot) {
  const errors = [];
  if (snapshot.redacted !== true) errors.push("redacted must be true");
  const seen = new Set();
  for (const node of snapshot.nodes) {
    if (seen.has(node.nodeId)) errors.push(`duplicate nodeId ${node.nodeId}`);
    seen.add(node.nodeId);
    if (!snapshot.frameIds.includes(node.frameId)) errors.push(`unknown frame ${node.nodeId}`);
    for (const key of ["left", "top", "width", "height"]) {
      if (typeof node.bounds[key] !== "number" || Number.isNaN(node.bounds[key])) errors.push(`bad bounds ${node.nodeId}`);
    }
  }
  const blob = JSON.stringify(snapshot);
  for (const kind of containedKinds(blob)) errors.push(`sentinel kind ${kind}`);
  return errors;
}

export async function validateBrowserSnapshot(snapshot, schemaPath) {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { default: addFormats } = await import("ajv-formats");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const $defs = {};
  for (const name of NEEDED_DEFS) $defs[name] = schema.$defs[name];
  const validate = ajv.compile({ $defs, $ref: "#/$defs/BrowserSnapshot" });
  const ok = validate(snapshot);
  return {
    ok: Boolean(ok) && extraInvariants(snapshot).length === 0,
    schemaOk: Boolean(ok),
    schemaErrors: (validate.errors || []).slice(0, 30).map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message,
    })),
    invariantErrors: extraInvariants(snapshot),
  };
}

export async function captureAria(page) {
  const locator = page.locator("body");
  if (typeof locator.ariaSnapshot !== "function") {
    return { ok: false, reason: "locator.ariaSnapshot is not a function" };
  }
  const yaml = await locator.ariaSnapshot();
  if (typeof yaml !== "string") return { ok: false, reason: `unexpected ${typeof yaml}` };
  return {
    ok: true,
    api: "locator.ariaSnapshot",
    containedSentinelKinds: containedKinds(yaml),
    yaml: redactText(yaml),
  };
}

export async function captureCdp(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("Accessibility.enable").catch(() => {});
    const tree = await cdp.send("Page.getFrameTree");
    const frameIds = [];
    walkFrames(tree.frameTree, frameIds);
    const axFrames = [];
    const axKinds = [];
    for (const frameId of frameIds) {
      try {
        const ax = await cdp.send("Accessibility.getFullAXTree", { frameId });
        const raw = JSON.stringify(ax);
        axKinds.push(...containedKinds(raw));
        axFrames.push({
          frameId,
          inaccessible: false,
          nodeCount: (ax.nodes || []).length,
          valueOmitted: (ax.nodes || []).filter((node) => node.value != null).length,
          sample: (ax.nodes || []).slice(0, 40).map((node) => ({
            role: node.role?.value || "",
            name: redactText(node.name?.value || "").slice(0, 200),
            ignored: Boolean(node.ignored),
            backendDOMNodeId: node.backendDOMNodeId ?? null,
            hasValue: node.value != null,
          })),
        });
      } catch (error) {
        axFrames.push({
          frameId,
          inaccessible: true,
          error: redactText(error.message).slice(0, 300),
          nodeCount: 0,
          valueOmitted: 0,
          sample: [],
        });
      }
    }
    const dom = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility"],
      includeDOMRects: true,
    });
    return {
      ok: true,
      api: "CDPSession.send DOMSnapshot.captureSnapshot + Accessibility.getFullAXTree",
      frameIds,
      axContainedSentinelKinds: [...new Set(axKinds)],
      ax: axFrames,
      dom: decodeDom(dom),
    };
  } catch (error) {
    return { ok: false, error: redactText(error.message).slice(0, 500) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function walkFrames(node, out) {
  if (node?.frame?.id) out.push(node.frame.id);
  for (const child of node?.childFrames || []) walkFrames(child, out);
}

function stringAt(strings, index) {
  if (typeof index === "string") return index;
  if (typeof index === "number" && index >= 0) return strings[index] ?? "";
  return "";
}

function rareStringMap(rare, strings) {
  const map = new Map();
  if (!rare || !Array.isArray(rare.index)) return map;
  rare.index.forEach((nodeIndex, i) => map.set(nodeIndex, stringAt(strings, rare.value?.[i])));
  return map;
}

function decodeDom(dom) {
  const strings = dom.strings || [];
  const containedSentinelKinds = containedKinds(JSON.stringify(dom));
  const allow = new Set(["id", "role", "name", "type", "data-testid", "aria-label", "title"]);
  const documents = (dom.documents || []).map((doc) => {
    const nodes = doc.nodes || {};
    const names = nodes.nodeName || [];
    const attributes = nodes.attributes || [];
    const inputValues = rareStringMap(nodes.inputValue, strings);
    const layoutIndex = doc.layout?.nodeIndex || [];
    const layoutBounds = doc.layout?.bounds || [];
    const boundsByNode = new Map();
    layoutIndex.forEach((nodeIndex, key) => {
      const box = layoutBounds[key];
      if (Array.isArray(box)) boundsByNode.set(nodeIndex, { left: box[0], top: box[1], width: box[2], height: box[3] });
    });
    let scriptNodesSkipped = 0;
    let inputValuesSeen = 0;
    let hiddenOrPasswordValuesOmitted = 0;
    const sample = [];
    for (let i = 0; i < names.length; i += 1) {
      const tag = stringAt(strings, names[i]).toLowerCase();
      if (tag === "script" || tag === "style") {
        scriptNodesSkipped += 1;
        continue;
      }
      const attrObj = {};
      let type = "";
      const rawAttrs = attributes[i] || [];
      for (let j = 0; j < rawAttrs.length; j += 2) {
        const key = stringAt(strings, rawAttrs[j]);
        const value = stringAt(strings, rawAttrs[j + 1]);
        if (key === "type") type = value.toLowerCase();
        if (key === "value") continue;
        if (allow.has(key)) attrObj[key] = redactText(value).slice(0, 200);
      }
      const hasInputValue = inputValues.has(i);
      if (hasInputValue) inputValuesSeen += 1;
      if (hasInputValue && (type === "hidden" || type === "password")) hiddenOrPasswordValuesOmitted += 1;
      if (sample.length < 30 && ["button", "input", "h1", "p", "iframe", "div"].includes(tag)) {
        sample.push({
          tag,
          attributes: attrObj,
          inputValueOmitted: hasInputValue,
          bounds: boundsByNode.get(i) || null,
        });
      }
    }
    return {
      frameId: doc.frameId || null,
      url: redactUrl(stringAt(strings, doc.documentURL)),
      title: redactText(stringAt(strings, doc.title)).slice(0, 200),
      nodeCount: names.length,
      scriptNodesSkipped,
      inputValuesSeen,
      hiddenOrPasswordValuesOmitted,
      sample,
    };
  });
  return { containedSentinelKinds, documentCount: documents.length, documents };
}

export function newId() {
  return randomUUID();
}
