import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ChatbotOutgoingFile } from "../../contracts/worker-contract";

// Discord 不會渲染 LaTeX。獨立公式（$$…$$、\[…\]）用 MathJax 轉成 SVG、再由
// resvg 點陣化成 PNG 當附件送出；行內公式（$…$、\(…\)）盡量改寫成 Unicode 純文字，
// 改寫不了的才升級成圖片。程式碼區塊和行內 code 裡的 $ 一律不碰。

// 整篇回覆最多轉幾張圖。Discord 的「每則訊息 10 個附件」另外在 placeFormulaFiles 套。
export const LATEX_MAX_FORMULAS = 40;
export const DISCORD_MAX_ATTACHMENTS_PER_MESSAGE = 10;
const LATEX_MAX_SOURCE_LENGTH = 2_000;
const EX_TO_PX = 20;
const IMAGE_PADDING = 24;
const IMAGE_BACKGROUND = "#ffffff";
const IMAGE_FOREGROUND = "#1e1f22";

export type LatexSegment =
  | { kind: "text"; value: string }
  | { kind: "display"; tex: string }
  | { kind: "inline"; tex: string };

// 順序有意義：code span 排最前面，才能把 `$HOME` 這種東西當文字略過。
// 行內 $…$ 採 Pandoc 規則：開頭 $ 後不能接空白，結尾 $ 前不能是空白、後不能接數字，
// 內容還得長得像數學（含 \ ^ _ 或 {），否則「$5 和 $10」會被吃掉。
const SEGMENT_PATTERN =
  /(`+)[^`\n]*?\1|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/gu;

export function splitLatexSegments(content: string): LatexSegment[] {
  const output: LatexSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = output[output.length - 1];
    if (last?.kind === "text") {
      last.value += value;
    } else {
      output.push({ kind: "text", value });
    }
  };

  // 圍欄外的文字累積起來一次套 SEGMENT_PATTERN；圍欄內的行原樣放回。
  let outside = "";
  const flushOutside = () => {
    if (!outside) return;
    let cursor = 0;
    for (const match of outside.matchAll(SEGMENT_PATTERN)) {
      const [
        whole,
        codeSpan,
        dollarDisplay,
        bracketDisplay,
        parenInline,
        dollarInline,
      ] = match;
      const start = match.index ?? 0;
      pushText(outside.slice(cursor, start));
      cursor = start + whole.length;
      if (codeSpan !== undefined) {
        pushText(whole);
        continue;
      }
      const display = dollarDisplay ?? bracketDisplay;
      if (display !== undefined) {
        output.push({ kind: "display", tex: display.trim() });
        continue;
      }
      const inline = parenInline ?? dollarInline;
      if (
        inline !== undefined &&
        (parenInline !== undefined || /[\\^_{]/u.test(inline))
      ) {
        output.push({ kind: "inline", tex: inline.trim() });
        continue;
      }
      pushText(whole);
    }
    pushText(outside.slice(cursor));
    outside = "";
  };

  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/(?<=\n)/u)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fence) {
      pushText(line);
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closing?.startsWith(fence.marker) && closing.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      flushOutside();
      fence = { marker: fenceMatch[1][0]!, length: fenceMatch[1].length };
      pushText(line);
      continue;
    }
    outside += line;
  }
  flushOutside();
  return output;
}

// ---------------------------------------------------------------------------
// 行內公式 → Unicode 純文字

const SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  infty: "∞",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  propto: "∝",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  ll: "≪",
  gg: "≫",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  mapsto: "↦",
  implies: "⇒",
  iff: "⇔",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  emptyset: "∅",
  varnothing: "∅",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  top: "⊤",
  bot: "⊥",
  sum: "∑",
  prod: "∏",
  int: "∫",
  iint: "∬",
  oint: "∮",
  partial: "∂",
  nabla: "∇",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  vdots: "⋮",
  ddots: "⋱",
  angle: "∠",
  perp: "⊥",
  parallel: "∥",
  circ: "∘",
  degree: "°",
  prime: "′",
  hbar: "ℏ",
  ell: "ℓ",
  Re: "ℜ",
  Im: "ℑ",
  aleph: "ℵ",
  star: "⋆",
  ast: "∗",
  bullet: "•",
  oplus: "⊕",
  otimes: "⊗",
  odot: "⊙",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  therefore: "∴",
  because: "∵",
  mid: "|",
  vert: "|",
  Vert: "‖",
  lvert: "|",
  rvert: "|",
  backslash: "\\",
  quad: " ",
  qquad: "  ",
  ",": "",
  ";": " ",
  ":": " ",
  "!": "",
  " ": " ",
  "{": "{",
  "}": "}",
  "%": "%",
  "&": "&",
  "#": "#",
  _: "_",
  $: "$",
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  arcsin: "arcsin",
  arccos: "arccos",
  arctan: "arctan",
  sinh: "sinh",
  cosh: "cosh",
  tanh: "tanh",
  log: "log",
  ln: "ln",
  lg: "lg",
  exp: "exp",
  lim: "lim",
  limsup: "limsup",
  liminf: "liminf",
  max: "max",
  min: "min",
  sup: "sup",
  inf: "inf",
  det: "det",
  dim: "dim",
  ker: "ker",
  deg: "deg",
  gcd: "gcd",
  arg: "arg",
  hom: "hom",
  mod: "mod",
  bmod: "mod",
  pmod: "mod",
};

const BLACKBOARD: Record<string, string> = {
  N: "ℕ",
  Z: "ℤ",
  Q: "ℚ",
  R: "ℝ",
  C: "ℂ",
  P: "ℙ",
  H: "ℍ",
};

const ACCENTS: Record<string, string> = {
  vec: "⃗",
  hat: "̂",
  bar: "̄",
  overline: "̅",
  dot: "̇",
  ddot: "̈",
  tilde: "̃",
};

const TEXT_WRAPPERS = new Set([
  "text",
  "textrm",
  "textbf",
  "textit",
  "textsf",
  "texttt",
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "mathcal",
  "mathscr",
  "mathfrak",
  "boldsymbol",
  "bm",
  "operatorname",
  "mbox",
]);

const DROPPED = new Set([
  "left",
  "right",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "limits",
  "nolimits",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "Biggl",
  "Biggr",
  "nonumber",
  "notag",
]);

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "ⁱ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
  T: "ᵀ",
  "∘": "°",
  " ": "",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
  " ": "",
};

class UnsupportedLatex extends Error {}

class PlainTextConverter {
  private pos = 0;

  constructor(private readonly source: string) {}

  convert(): string {
    return this.parseUntil(undefined);
  }

  private parseUntil(closing: string | undefined): string {
    let output = "";
    while (this.pos < this.source.length) {
      const char = this.source[this.pos]!;
      if (closing !== undefined && char === closing) {
        this.pos += 1;
        return output;
      }
      if (char === "}") {
        // 多餘的右括號，略過就好。
        this.pos += 1;
        continue;
      }
      if (char === "{") {
        this.pos += 1;
        output += this.parseUntil("}");
        continue;
      }
      if (char === "\\") {
        output += this.parseCommand();
        continue;
      }
      if (char === "^" || char === "_") {
        this.pos += 1;
        output += this.parseScript(char);
        continue;
      }
      if (char === "&") {
        throw new UnsupportedLatex("alignment");
      }
      output += char;
      this.pos += 1;
    }
    if (closing !== undefined) {
      throw new UnsupportedLatex("unbalanced braces");
    }
    return output;
  }

  private readGroup(): string {
    this.skipSpaces();
    if (this.source[this.pos] === "{") {
      this.pos += 1;
      return this.parseUntil("}");
    }
    return this.readArgument();
  }

  private readRawGroup() {
    this.skipSpaces();
    if (this.source[this.pos] !== "{") {
      throw new UnsupportedLatex("missing group");
    }
    let depth = 0;
    const start = this.pos + 1;
    for (; this.pos < this.source.length; this.pos += 1) {
      const char = this.source[this.pos];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const value = this.source.slice(start, this.pos);
          this.pos += 1;
          return value;
        }
      }
    }
    throw new UnsupportedLatex("unbalanced braces");
  }

  private readOptional() {
    this.skipSpaces();
    if (this.source[this.pos] !== "[") return undefined;
    const end = this.source.indexOf("]", this.pos);
    if (end === -1) throw new UnsupportedLatex("unbalanced bracket");
    const value = this.source.slice(this.pos + 1, end);
    this.pos = end + 1;
    return value;
  }

  // 單一 token：一個字元，或一個 \指令（含其自身參數）。
  private readArgument(): string {
    this.skipSpaces();
    const char = this.source[this.pos];
    if (char === undefined) throw new UnsupportedLatex("missing argument");
    if (char === "{") {
      this.pos += 1;
      return this.parseUntil("}");
    }
    if (char === "\\") return this.parseCommand();
    this.pos += 1;
    return char;
  }

  private skipSpaces() {
    while (this.source[this.pos] === " ") this.pos += 1;
  }

  private parseScript(kind: "^" | "_"): string {
    const inner = this.readArgument();
    const table = kind === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
    const mapped = Array.from(inner).map((char) => table[char]);
    if (mapped.every((value) => value !== undefined)) {
      return mapped.join("");
    }
    return Array.from(inner).length === 1
      ? `${kind}${inner}`
      : `${kind}(${inner})`;
  }

  private parseCommand(): string {
    this.pos += 1;
    const letters = this.source.slice(this.pos).match(/^[A-Za-z]+/u)?.[0];
    const name = letters ?? this.source[this.pos];
    if (name === undefined) throw new UnsupportedLatex("dangling backslash");
    this.pos += name.length;

    if (DROPPED.has(name)) return "";
    if (TEXT_WRAPPERS.has(name)) return this.readGroup();
    if (name === "mathbb") {
      const inner = this.readRawGroup().trim();
      const mapped = BLACKBOARD[inner];
      if (!mapped) throw new UnsupportedLatex(`\\mathbb{${inner}}`);
      return mapped;
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = this.readGroup();
      const denominator = this.readGroup();
      return `${wrapOperand(numerator)}/${wrapOperand(denominator)}`;
    }
    if (name === "sqrt") {
      const index = this.readOptional();
      const radicand = this.readGroup();
      const root =
        index === undefined
          ? "√"
          : index === "3"
            ? "∛"
            : index === "4"
              ? "∜"
              : undefined;
      if (!root) throw new UnsupportedLatex(`\\sqrt[${index}]`);
      return `${root}${wrapOperand(radicand)}`;
    }
    const accent = ACCENTS[name];
    if (accent) {
      const inner = this.readGroup();
      if (Array.from(inner).length !== 1)
        throw new UnsupportedLatex(`\\${name}`);
      return `${inner}${accent}`;
    }
    const symbol = SYMBOLS[name];
    if (symbol !== undefined) {
      // 函數名後面直接接字母或數字時補一格空白，避免 \sin x 黏成 sinx；
      // 接 _、^、( 的情況（\lim_{…}、\sin(x)）不補。
      const followedByToken = /^[\p{L}\p{N}\\]/u.test(
        this.source.slice(this.pos).trimStart(),
      );
      return /^[a-z]+$/u.test(symbol) && followedByToken
        ? `${symbol} `
        : symbol;
    }
    throw new UnsupportedLatex(`\\${name}`);
  }
}

function wrapOperand(value: string) {
  const trimmed = value.trim();
  return /^[\p{L}\p{N}⁰-₟²³¹]+$/u.test(trimmed) ? trimmed : `(${trimmed})`;
}

// 回傳 undefined 表示這段行內公式改寫不成純文字，得改用圖片。
export function latexToPlainText(tex: string): string | undefined {
  try {
    return new PlainTextConverter(tex)
      .convert()
      .replace(/ +/gu, " ")
      .replace(/ ([,)])/gu, "$1")
      .replace(/\( /gu, "(")
      .trim();
  } catch (error) {
    if (error instanceof UnsupportedLatex) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 獨立公式 → PNG

type Renderer = {
  toSvg: (tex: string) => string;
  Resvg: typeof import("@resvg/resvg-wasm").Resvg;
};

let rendererPromise: Promise<Renderer> | undefined;

async function loadRenderer(): Promise<Renderer> {
  const [
    { mathjax },
    { TeX },
    { SVG },
    { liteAdaptor },
    { RegisterHTMLHandler },
    { AllPackages },
    resvg,
  ] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
    import("@resvg/resvg-wasm"),
  ]);

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    // 不裝 noundefined：未知指令要變成 merror 退回原文，而不是畫成紅字。
    InputJax: new TeX({
      packages: AllPackages.filter((name) => name !== "noundefined"),
    }),
    OutputJax: new SVG({ fontCache: "none" }),
  });

  const require = createRequire(import.meta.url);
  const wasmPath = join(
    dirname(require.resolve("@resvg/resvg-wasm")),
    "index_bg.wasm",
  );
  await resvg.initWasm(await readFile(wasmPath));

  return {
    toSvg: (tex) => adaptor.outerHTML(document.convert(tex, { display: true })),
    Resvg: resvg.Resvg,
  };
}

function rendererInstance() {
  rendererPromise ??= loadRenderer().catch((error) => {
    rendererPromise = undefined;
    throw error;
  });
  return rendererPromise;
}

// 頂層的 \\ 換行 MathJax 不會理（x=1\\y=2 會黏成一行），包進 gathered 才會分行。
// 環境（cases、pmatrix）自己開頭的就不用包。
function withLineBreaks(tex: string) {
  return tex.includes("\\\\") && !/^\s*\\begin\{/u.test(tex)
    ? `\\begin{gathered}${tex}\\end{gathered}`
    : tex;
}

// 轉不出來（TeX 有錯、MathJax 內部例外、SVG 尺寸讀不到）就回 undefined，讓呼叫端保留原文。
export async function renderLatexPng(
  tex: string,
): Promise<Uint8Array | undefined> {
  if (!tex.trim() || tex.length > LATEX_MAX_SOURCE_LENGTH) return undefined;
  let renderer: Renderer;
  try {
    renderer = await rendererInstance();
  } catch (error) {
    console.warn("[latex] renderer unavailable:", error);
    return undefined;
  }

  try {
    const container = renderer.toSvg(withLineBreaks(tex));
    if (container.includes('data-mml-node="merror"')) return undefined;
    const svg = container.match(/<svg[\s\S]*<\/svg>/u)?.[0];
    if (!svg) return undefined;
    const widthEx = Number(svg.match(/\bwidth="([\d.]+)ex"/u)?.[1]);
    const heightEx = Number(svg.match(/\bheight="([\d.]+)ex"/u)?.[1]);
    if (!Number.isFinite(widthEx) || !Number.isFinite(heightEx))
      return undefined;

    const width = Math.ceil(widthEx * EX_TO_PX);
    const height = Math.ceil(heightEx * EX_TO_PX);
    const inner = svg
      .replace(/\bwidth="[\d.]+ex"/u, `width="${width}"`)
      .replace(/\bheight="[\d.]+ex"/u, `height="${height}"`)
      .replace(/ style="[^"]*"/u, "")
      .replaceAll("currentColor", IMAGE_FOREGROUND);
    const wrapped =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width + IMAGE_PADDING * 2}" height="${height + IMAGE_PADDING * 2}">` +
      `<rect width="100%" height="100%" fill="${IMAGE_BACKGROUND}"/>` +
      `<g transform="translate(${IMAGE_PADDING},${IMAGE_PADDING})">${inner}</g></svg>`;
    return new renderer.Resvg(wrapped, { fitTo: { mode: "original" } })
      .render()
      .asPng();
  } catch (error) {
    console.warn("[latex] render failed:", error);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 整合：把回覆裡的公式換成佔位符，並產生附件

export type LatexFormulaFile = {
  placeholder: string;
  file: ChatbotOutgoingFile;
};

export type LatexAttachmentResult = {
  content: string;
  formulas: LatexFormulaFile[];
};

function formulaPlaceholder(index: number, total: number) {
  return total === 1 ? "[公式]" : `[公式 ${index + 1}]`;
}

function rawFormula(tex: string) {
  return tex.includes("`") ? tex : `\`${tex}\``;
}

export async function attachLatexFormulas(
  content: string,
  slots = LATEX_MAX_FORMULAS,
): Promise<LatexAttachmentResult> {
  const segments = splitLatexSegments(content);
  if (!segments.some((segment) => segment.kind !== "text")) {
    return { content, formulas: [] };
  }

  // 先決定每段要變成什麼，再渲染，最後才組字串——佔位符要不要編號取決於總數。
  const pending: Array<{ index: number; tex: string }> = [];
  const output: string[] = segments.map((segment, index) => {
    if (segment.kind === "text") return segment.value;
    if (segment.kind === "inline") {
      const plain = latexToPlainText(segment.tex);
      if (plain !== undefined) return plain;
    }
    if (pending.length < Math.max(0, slots)) {
      pending.push({ index, tex: segment.tex });
    }
    return rawFormula(segment.tex);
  });

  const rendered: Array<{ index: number; file: ChatbotOutgoingFile }> = [];
  for (const { index, tex } of pending) {
    const png = await renderLatexPng(tex);
    if (!png) continue;
    rendered.push({
      index,
      file: {
        filename: `formula-${rendered.length + 1}.png`,
        contentType: "image/png",
        size: png.byteLength,
        data: Buffer.from(png).toString("base64"),
      },
    });
  }

  const formulas = rendered.map(({ index, file }, ordinal) => {
    const placeholder = formulaPlaceholder(ordinal, rendered.length);
    output[index] = placeholder;
    return { placeholder, file };
  });

  return { content: output.join(""), formulas };
}

// 回覆會被拆成多則訊息（每個空行一則），每張圖要跟著自己佔位符所在的那一則；
// 佔位符找不到（被截斷了）就掛在最後一則。一則塞滿 10 個附件時溢到下一則，
// `reservedInFirst` 是第一則已經被 worker 附件佔掉的名額。
export function placeFormulaFiles(
  parts: string[],
  formulas: LatexFormulaFile[],
  reservedInFirst = 0,
): ChatbotOutgoingFile[][] {
  const byPart: ChatbotOutgoingFile[][] = parts.map(() => []);
  if (parts.length === 0) return byPart;
  const used = parts.map((_, index) => (index === 0 ? reservedInFirst : 0));
  for (const { placeholder, file } of formulas) {
    const wanted = parts.findIndex((part) => part.includes(placeholder));
    let index = wanted === -1 ? parts.length - 1 : wanted;
    while (
      index < parts.length - 1 &&
      used[index]! >= DISCORD_MAX_ATTACHMENTS_PER_MESSAGE
    ) {
      index += 1;
    }
    if (used[index]! >= DISCORD_MAX_ATTACHMENTS_PER_MESSAGE) continue;
    byPart[index]!.push(file);
    used[index]! += 1;
  }
  return byPart;
}
