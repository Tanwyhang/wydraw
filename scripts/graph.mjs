// Native Excalidraw groups and reciprocal bindings survive manual editing.
const bindable = new Set(["rectangle", "ellipse", "diamond", "image", "text"]);
export function connect(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    if (e.type !== "arrow") continue;
    for (const [short, native] of [
      ["startElementId", "startBinding"],
      ["endElementId", "endBinding"],
    ]) {
      if (Object.hasOwn(e, short)) {
        const id = e[short];
        delete e[short];
        e[native] = id ? { elementId: id, focus: 0, gap: 4 } : null;
      }
      const id = e[native]?.elementId;
      if (id && (!byId.has(id) || !bindable.has(byId.get(id).type)))
        throw Error(`Dangling or invalid arrow endpoint: ${id}`);
    }
  }
  for (const e of elements)
    e.boundElements = (e.boundElements ?? []).filter((b) => b.type !== "arrow");
  for (const e of elements)
    if (e.type === "arrow") {
      for (const id of new Set(
        [e.startBinding?.elementId, e.endBinding?.elementId].filter(Boolean),
      )) {
        byId.get(id).boundElements.push({ id: e.id, type: "arrow" });
      }
    }
}

export function group(elements, groups = []) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const { id, elements: members } of groups) {
    if (!id || !Array.isArray(members))
      throw Error("Groups require id and elements");
    for (const member of members)
      if (!byId.has(member)) throw Error(`Unknown group member: ${member}`);
    const selected = new Set(members);
    for (const e of elements)
      if (e.containerId && selected.has(e.containerId)) selected.add(e.id);
    for (const e of elements) {
      const ids = (e.groupIds ?? []).filter((g) => g !== id);
      if (selected.has(e.id)) ids.push(id);
      if (e.locked && JSON.stringify(ids) !== JSON.stringify(e.groupIds ?? []))
        throw Error(`Locked element: ${e.id}`);
      e.groupIds = ids;
    }
  }
  for (const e of elements)
    if (e.containerId && byId.has(e.containerId))
      e.groupIds = [...(byId.get(e.containerId).groupIds ?? [])];
}

class Heap {
  items = [];
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= item.cost) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items,
      result = a[0],
      last = a.pop();
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let c = 2 * i + 1;
        if (c + 1 < a.length && a[c + 1].cost < a[c].cost) c++;
        if (a[c].cost >= last.cost) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return result;
  }
}
const ports = (e) => [
  [e.x - 12, e.y + e.height / 2],
  [e.x + e.width + 12, e.y + e.height / 2],
  [e.x + e.width / 2, e.y - 12],
  [e.x + e.width / 2, e.y + e.height + 12],
];
const contains = (a, b) =>
  a.x <= b.x &&
  a.y <= b.y &&
  a.x + a.width >= b.x + b.width &&
  a.y + a.height >= b.y + b.height;
const segments = (e) =>
  (e.points ?? []).slice(1).map((p, i) => [
    [e.x + e.points[i][0], e.y + e.points[i][1]],
    [e.x + p[0], e.y + p[1]],
  ]);
function blocked(a, b, r) {
  if (a[0] === b[0])
    return (
      a[0] > r[0] &&
      a[0] < r[2] &&
      Math.max(a[1], b[1]) > r[1] &&
      Math.min(a[1], b[1]) < r[3]
    );
  return (
    a[1] > r[1] &&
    a[1] < r[3] &&
    Math.max(a[0], b[0]) > r[0] &&
    Math.min(a[0], b[0]) < r[2]
  );
}
function crossing(a, b, c, d) {
  const horizontal = a[1] === b[1],
    other = c[1] === d[1];
  if (horizontal === other) return 0;
  const [h1, h2, v1, v2] = horizontal ? [a, b, c, d] : [c, d, a, b];
  return v1[0] > Math.min(h1[0], h2[0]) &&
    v1[0] < Math.max(h1[0], h2[0]) &&
    h1[1] > Math.min(v1[1], v2[1]) &&
    h1[1] < Math.max(v1[1], v2[1])
    ? 80
    : 0;
}

// Sparse orthogonal visibility grid, shortest path with bend/crossing costs.
// This is a deterministic heuristic, not a global minimum-crossing solver.
export function untangle(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const used = elements
    .filter(
      (e) =>
        e.type === "arrow" && (e.locked || !e.startBinding || !e.endBinding),
    )
    .flatMap(segments);
  for (const edge of elements) {
    if (edge.type !== "arrow" || edge.locked) continue;
    const from = byId.get(edge.startBinding?.elementId),
      to = byId.get(edge.endBinding?.elementId);
    if (!from || !to || from === to || from.angle || to.angle) continue;
    const labels = elements.filter((e) => e.containerId === edge.id);
    if (labels.some((e) => e.locked)) continue;
    const obstacles = elements.filter(
      (e) =>
        ["rectangle", "ellipse", "diamond", "image"].includes(e.type) &&
        !(
          e.id !== from.id &&
          e.id !== to.id &&
          (contains(e, from) ||
            contains(e, to) ||
            contains(from, e) ||
            contains(to, e))
        ),
    );
    const rects = obstacles.map((e) => {
      const c = Math.abs(Math.cos(e.angle ?? 0)),
        s = Math.abs(Math.sin(e.angle ?? 0));
      const w = e.width * c + e.height * s,
        h = e.width * s + e.height * c;
      return [
        e.x + e.width / 2 - w / 2 - 8,
        e.y + e.height / 2 - h / 2 - 8,
        e.x + e.width / 2 + w / 2 + 8,
        e.y + e.height / 2 + h / 2 + 8,
      ];
    });
    const starts = ports(from),
      ends = ports(to);
    const xs = [
      ...new Set(
        [...starts, ...ends]
          .map((p) => p[0])
          .concat(rects.flatMap((r) => [r[0], r[2]])),
      ),
    ].sort((a, b) => a - b);
    const ys = [
      ...new Set(
        [...starts, ...ends]
          .map((p) => p[1])
          .concat(rects.flatMap((r) => [r[1], r[3]])),
      ),
    ].sort((a, b) => a - b);
    if (xs.length * ys.length > 50000) continue; // Bound interactive work on unusually dense scenes.
    const point = (n) => [xs[n % xs.length], ys[Math.floor(n / xs.length)]];
    const index = (p) => ys.indexOf(p[1]) * xs.length + xs.indexOf(p[0]);
    const targets = new Set(ends.map(index));
    const heap = new Heap(),
      costs = new Map(),
      previous = new Map();
    for (const p of starts) {
      const key = index(p) * 3 + 2;
      costs.set(key, 0);
      heap.push({ key, cost: 0 });
    }
    let found;
    while (heap.items.length) {
      const { key, cost } = heap.pop();
      if (cost !== costs.get(key)) continue;
      const n = Math.floor(key / 3),
        dir = key % 3,
        a = point(n);
      if (targets.has(n)) {
        found = key;
        break;
      }
      const xi = n % xs.length,
        yi = Math.floor(n / xs.length);
      for (const [x, y, d] of [
        [xi - 1, yi, 0],
        [xi + 1, yi, 0],
        [xi, yi - 1, 1],
        [xi, yi + 1, 1],
      ]) {
        if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
        const nn = y * xs.length + x,
          b = point(nn);
        if (rects.some((r) => blocked(a, b, r))) continue;
        const nc =
          cost +
          Math.abs(a[0] - b[0]) +
          Math.abs(a[1] - b[1]) +
          (dir !== 2 && dir !== d ? 24 : 0) +
          used.reduce((sum, [c, e]) => sum + crossing(a, b, c, e), 0);
        const nk = nn * 3 + d;
        if (nc < (costs.get(nk) ?? Infinity)) {
          costs.set(nk, nc);
          previous.set(nk, key);
          heap.push({ key: nk, cost: nc });
        }
      }
    }
    if (found === undefined) continue;
    const route = [];
    for (let key = found; key !== undefined; key = previous.get(key))
      route.unshift(point(Math.floor(key / 3)));
    const simple = route.filter(
      (p, i) =>
        !i ||
        i === route.length - 1 ||
        !(
          (route[i - 1][0] === p[0] && p[0] === route[i + 1][0]) ||
          (route[i - 1][1] === p[1] && p[1] === route[i + 1][1])
        ),
    );
    if (simple.length < 2) continue;
    const [x, y] = simple[0];
    Object.assign(edge, {
      x,
      y,
      points: simple.map((p) => [p[0] - x, p[1] - y]),
      width:
        Math.max(...simple.map((p) => p[0])) -
        Math.min(...simple.map((p) => p[0])),
      height:
        Math.max(...simple.map((p) => p[1])) -
        Math.min(...simple.map((p) => p[1])),
      roundness: null,
      elbowed: false,
      version: (edge.version ?? 1) + 1,
    });
    edge.startBinding = { ...edge.startBinding, focus: 0, gap: 12 };
    edge.endBinding = { ...edge.endBinding, focus: 0, gap: 12 };
    const segs = segments(edge);
    used.push(...segs);
    const [a, b] = segs.reduce((best, s) =>
      Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) >
      Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])
        ? s
        : best,
    );
    for (const label of labels) {
      label.x = (a[0] + b[0]) / 2 - label.width / 2;
      label.y = (a[1] + b[1]) / 2 - label.height / 2;
    }
  }
  return elements;
}
