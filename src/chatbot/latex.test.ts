import { describe, expect, test } from "bun:test";

import {
  attachLatexFormulas,
  latexToPlainText,
  placeFormulaFiles,
  renderLatexPng,
  splitLatexSegments,
} from "./latex";

describe("splitLatexSegments", () => {
  test("finds display and inline math in all four delimiter styles", () => {
    expect(
      splitLatexSegments("a $$x^2$$ b \\[y_1\\] c \\(z\\) d $w^2$ e"),
    ).toEqual([
      { kind: "text", value: "a " },
      { kind: "display", tex: "x^2" },
      { kind: "text", value: " b " },
      { kind: "display", tex: "y_1" },
      { kind: "text", value: " c " },
      { kind: "inline", tex: "z" },
      { kind: "text", value: " d " },
      { kind: "inline", tex: "w^2" },
      { kind: "text", value: " e" },
    ]);
  });

  test("display math may span lines", () => {
    expect(splitLatexSegments("前\n$$\n\\int_0^1 x\\,dx\n$$\n後")).toEqual([
      { kind: "text", value: "前\n" },
      { kind: "display", tex: "\\int_0^1 x\\,dx" },
      { kind: "text", value: "\n後" },
    ]);
  });

  test("leaves currency and bare dollars alone", () => {
    const content = "這個 $5 那個 $10，總共 $15 而已";
    expect(splitLatexSegments(content)).toEqual([
      { kind: "text", value: content },
    ]);
    expect(splitLatexSegments("$5 - $3 = $2")).toEqual([
      { kind: "text", value: "$5 - $3 = $2" },
    ]);
  });

  test("skips fenced code blocks and inline code", () => {
    const content =
      "外面 $x^2$\n```sh\necho $$ $HOME $x^2$\n```\n裡面 `$a_1$` 完";
    expect(splitLatexSegments(content)).toEqual([
      { kind: "text", value: "外面 " },
      { kind: "inline", tex: "x^2" },
      {
        kind: "text",
        value: "\n```sh\necho $$ $HOME $x^2$\n```\n裡面 `$a_1$` 完",
      },
    ]);
  });

  test("returns a single text segment when there is no math", () => {
    expect(splitLatexSegments("沒有數學")).toEqual([
      { kind: "text", value: "沒有數學" },
    ]);
  });
});

describe("latexToPlainText", () => {
  const cases: Array<[string, string]> = [
    ["x^2 + y^2 = r^2", "x² + y² = r²"],
    ["a_1, a_2, \\ldots, a_n", "a₁, a₂, …, aₙ"],
    ["\\alpha + \\beta = \\gamma", "α + β = γ"],
    ["\\frac{a}{b}", "a/b"],
    ["\\frac{a+b}{c}", "(a+b)/c"],
    ["\\sqrt{2}", "√2"],
    ["\\sqrt{b^2 - 4ac}", "√(b² - 4ac)"],
    ["\\sqrt[3]{x}", "∛x"],
    ["x \\in \\mathbb{R}", "x ∈ ℝ"],
    ["\\sum_{i=1}^{n} i", "∑ᵢ₌₁ⁿ i"],
    ["e^{-x}", "e⁻ˣ"],
    ["x^{10}", "x¹⁰"],
    ["\\sin x + \\cos x", "sin x + cos x"],
    ["\\left( a \\right)", "(a)"],
    ["\\sin(x)", "sin(x)"],
    ["\\text{速度} = 3", "速度 = 3"],
    ["90^\\circ", "90°"],
    ["\\vec{v}", "v⃗"],
    ["n \\to \\infty", "n → ∞"],
    ["\\lim_{x \\to 0}", "lim_(x → 0)"],
    ["a \\leq b \\neq c", "a ≤ b ≠ c"],
    ["x_{ab}", "x_(ab)"],
    ["x_b", "x_b"],
  ];
  for (const [tex, plain] of cases) {
    test(`${tex} → ${plain}`, () => {
      expect(latexToPlainText(tex)).toBe(plain);
    });
  }

  test("gives up on commands it cannot express as text", () => {
    expect(latexToPlainText("\\binom{n}{k}")).toBeUndefined();
    expect(
      latexToPlainText("\\begin{matrix} a & b \\end{matrix}"),
    ).toBeUndefined();
    expect(latexToPlainText("\\mathbb{X}")).toBeUndefined();
    expect(latexToPlainText("\\frac{a}{")).toBeUndefined();
  });
});

describe("renderLatexPng", () => {
  test("renders a PNG", async () => {
    const png = await renderLatexPng(
      "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
    );
    expect(png).toBeDefined();
    expect(Array.from(png!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png!.byteLength).toBeGreaterThan(1_000);
  });

  test("returns undefined for broken TeX", async () => {
    expect(await renderLatexPng("\\frac{a}{")).toBeUndefined();
    expect(await renderLatexPng("\\notacommand{x}")).toBeUndefined();
    expect(await renderLatexPng("")).toBeUndefined();
  });

  test("breaks lines on top-level \\\\", async () => {
    // gathered 會把三行疊起來：高度明顯大於單行，寬度明顯小於黏成一行。
    const stacked = await renderLatexPng("x=3-2t\\\\y=1+t\\\\z=t");
    const single = await renderLatexPng("x=3-2t \\quad y=1+t \\quad z=t");
    const size = (png: Uint8Array) => ({
      width: new DataView(png.buffer, png.byteOffset).getUint32(16),
      height: new DataView(png.buffer, png.byteOffset).getUint32(20),
    });
    expect(size(stacked!).height).toBeGreaterThan(size(single!).height * 2);
    expect(size(stacked!).width).toBeLessThan(size(single!).width);
  });

  test("keeps rendering after a failure", async () => {
    await renderLatexPng("\\frac{a}{");
    expect(await renderLatexPng("x^2")).toBeDefined();
  });
});

describe("attachLatexFormulas", () => {
  test("returns the content untouched without math", async () => {
    const result = await attachLatexFormulas("純文字 $5 而已");
    expect(result).toEqual({ content: "純文字 $5 而已", formulas: [] });
  });

  test("rewrites inline math and attaches display math", async () => {
    const result = await attachLatexFormulas(
      "解 $ax^2+bx+c=0$：\n$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$\n記起來",
    );
    expect(result.content).toBe("解 ax²+bx+c=0：\n[公式]\n記起來");
    expect(result.formulas).toHaveLength(1);
    expect(result.formulas[0]!.placeholder).toBe("[公式]");
    expect(result.formulas[0]!.file).toMatchObject({
      filename: "formula-1.png",
      contentType: "image/png",
    });
    expect(result.formulas[0]!.file.size).toBe(
      Buffer.from(result.formulas[0]!.file.data, "base64").byteLength,
    );
  });

  test("numbers placeholders when there are several formulas", async () => {
    const result = await attachLatexFormulas("$$a$$ 和 $$b$$");
    expect(result.content).toBe("[公式 1] 和 [公式 2]");
    expect(result.formulas.map((formula) => formula.placeholder)).toEqual([
      "[公式 1]",
      "[公式 2]",
    ]);
    expect(result.formulas.map((formula) => formula.file.filename)).toEqual([
      "formula-1.png",
      "formula-2.png",
    ]);
  });

  test("promotes inline math it cannot spell out to an image", async () => {
    const result = await attachLatexFormulas("選法有 $\\binom{n}{k}$ 種");
    expect(result.content).toBe("選法有 [公式] 種");
    expect(result.formulas).toHaveLength(1);
  });

  test("keeps the source as code when rendering fails or slots run out", async () => {
    const broken = await attachLatexFormulas("看 $$\\frac{a}{$$ 這個");
    expect(broken.content).toBe("看 `\\frac{a}{` 這個");
    expect(broken.formulas).toEqual([]);

    const capped = await attachLatexFormulas("$$a$$ $$b$$ $$c$$", 2);
    expect(capped.content).toBe("[公式 1] [公式 2] `c`");
    expect(capped.formulas).toHaveLength(2);
  });
});

describe("placeFormulaFiles", () => {
  const file = (filename: string) => ({
    filename,
    contentType: "image/png",
    size: 0,
    data: "",
  });

  test("attaches each image to the part holding its placeholder", () => {
    const parts = ["令\n[公式 1]", "那麼\n[公式 2]", "懂了沒"];
    expect(
      placeFormulaFiles(parts, [
        { placeholder: "[公式 1]", file: file("a.png") },
        { placeholder: "[公式 2]", file: file("b.png") },
      ]),
    ).toEqual([[file("a.png")], [file("b.png")], []]);
  });

  test("falls back to the last part when a placeholder is missing", () => {
    expect(
      placeFormulaFiles(
        ["前", "後"],
        [{ placeholder: "[公式]", file: file("a.png") }],
      ),
    ).toEqual([[], [file("a.png")]]);
    expect(placeFormulaFiles([], [])).toEqual([]);
  });

  test("spills over to the next part when a message is full", () => {
    const formulas = Array.from({ length: 12 }, (_, index) => ({
      placeholder: `[公式 ${index + 1}]`,
      file: file(`${index + 1}.png`),
    }));
    const parts = [formulas.map((f) => f.placeholder).join(" "), "尾巴"];
    const placed = placeFormulaFiles(parts, formulas);
    expect(placed[0]!.map((f) => f.filename)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index + 1}.png`),
    );
    expect(placed[1]!.map((f) => f.filename)).toEqual(["11.png", "12.png"]);
  });

  test("counts worker files already on the first part", () => {
    const formulas = Array.from({ length: 3 }, (_, index) => ({
      placeholder: `[公式 ${index + 1}]`,
      file: file(`${index + 1}.png`),
    }));
    const placed = placeFormulaFiles(
      ["[公式 1] [公式 2] [公式 3]", "後"],
      formulas,
      9,
    );
    expect(placed[0]!.map((f) => f.filename)).toEqual(["1.png"]);
    expect(placed[1]!.map((f) => f.filename)).toEqual(["2.png", "3.png"]);
  });

  test("drops what does not fit in the last part", () => {
    const formulas = Array.from({ length: 11 }, (_, index) => ({
      placeholder: `[公式 ${index + 1}]`,
      file: file(`${index + 1}.png`),
    }));
    const placed = placeFormulaFiles(["單一則"], formulas);
    expect(placed[0]).toHaveLength(10);
  });
});

test("attachLatexFormulas renders more than ten formulas per reply", async () => {
  const content = Array.from(
    { length: 12 },
    (_, index) => `$$x_{${index}}$$`,
  ).join("\n\n");
  const result = await attachLatexFormulas(content);
  expect(result.formulas).toHaveLength(12);
});
