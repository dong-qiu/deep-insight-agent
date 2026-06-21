/** 文章全文抓取（标题党 RSS 补全）：extractArticleHtml 抽正文容器（纯函数）+ fetchArticleBody 编排
 *  （mock robots/safe-fetch，覆盖成功/robots禁/非2xx/非HTML/过短/异常）。 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { responses } = vi.hoisted(() => ({
  responses: new Map<string, { ok: boolean; text: string; ct?: string }>(),
}));

vi.mock("./safe-fetch.js", () => ({
  MAX_RESPONSE_BYTES: 8_000_000,
  safeFetch: vi.fn(async (url: string) => {
    const r = responses.get(url);
    if (!r) throw new Error(`unmocked fetch ${url}`);
    return {
      ok: r.ok,
      _text: r.text,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? (r.ct ?? "text/html") : null) },
    } as unknown as Response;
  }),
  readTextCapped: vi.fn(async (res: { _text: string }) => res._text),
}));
const { robotsRules } = vi.hoisted(() => ({ robotsRules: { value: { disallow: [] as string[] } } }));
vi.mock("./robots.js", () => ({
  UA: "Bot",
  fetchRobots: vi.fn(async () => robotsRules.value),
  isAllowed: vi.fn((rules: { disallow: string[] }, path: string) => !rules.disallow.some((d) => path.startsWith(d))),
}));

const { extractArticleHtml, fetchArticleBody, articleFetchEnabled } = await import("./article.js");

afterEach(() => {
  responses.clear();
  robotsRules.value = { disallow: [] };
  delete process.env.ARTICLE_FETCH;
});

describe("extractArticleHtml（抽正文容器，纯函数）", () => {
  it("安全客式 <div class=content id=js-article>：抽容器、剔除 nav/footer，嵌套 div 正确配对", () => {
    const html = `<html><body><nav>导航菜单</nav>
      <div class="content" id="js-article"><p>正文第一段</p><div class="img">插图说明</div><p>正文第二段</p></div>
      <footer>版权页脚</footer></body></html>`;
    const out = extractArticleHtml(html);
    expect(out).toContain("正文第一段");
    expect(out).toContain("插图说明"); // 嵌套 div 内容保留
    expect(out).toContain("正文第二段");
    expect(out).not.toContain("导航菜单");
    expect(out).not.toContain("版权页脚");
  });

  it("按源 container token 最高优先（决定③）：命中指定容器、压过全局白名单", () => {
    // 页面里有泛 content（全局白名单会命中），但正文在自定义容器 entry-main 里
    const html = `<body><div class="content">导航和推荐</div>
      <div class="entry-main"><p>真正文在自定义容器里足够长</p></div></body>`;
    const out = extractArticleHtml(html, "entry-main");
    expect(out).toContain("真正文在自定义容器");
    expect(out).not.toContain("导航和推荐");
  });

  it("container token 正则注入安全（特殊字符被转义、不报错）", () => {
    const out = extractArticleHtml(`<body><div class="x"><p>正文</p></div></body>`, "a.b(c)[d]");
    expect(typeof out).toBe("string"); // 不抛；找不到该容器 → 回退
  });

  it("丢弃 script/style，不被其中的标签字符串干扰配对", () => {
    const html = `<body><article><script>var x="</article>"</script><p>真正文</p><style>.a{}</style></article><footer>脚</footer></body>`;
    const out = extractArticleHtml(html);
    expect(out).toContain("真正文");
    expect(out).not.toContain("脚");
    expect(out).not.toContain("var x");
  });

  it("<article> 语义标签", () => {
    const out = extractArticleHtml(`<body><header>头</header><article><p>文章体</p></article><aside>边栏</aside></body>`);
    expect(out).toContain("文章体");
    expect(out).not.toContain("边栏");
  });

  it("无可识别容器 → 回退 <body> 内容", () => {
    const out = extractArticleHtml(`<html><head><title>T</title></head><body><p>裸正文</p></body></html>`);
    expect(out).toContain("裸正文");
    expect(out).not.toContain("<title>");
  });
});

describe("fetchArticleBody（编排 + 失败兜底）", () => {
  const longBody = "这是一段足够长的中文正文内容".repeat(30); // > MIN_ARTICLE_CHARS
  const page = (b: string) => `<html><body><nav>菜单</nav><div id="js-article" class="content"><p>${b}</p></div></body></html>`;

  it("成功：robots 放行 + 200 HTML + 抽到正文 → 返回含正文的 HTML 片段", async () => {
    responses.set("https://site/post/1", { ok: true, text: page(longBody) });
    const out = await fetchArticleBody("https://site/post/1");
    expect(out).not.toBeNull();
    expect(out).toContain(longBody.slice(0, 12));
    expect(out).not.toContain("菜单");
  });

  it("robots 禁止 → null（不抓）", async () => {
    robotsRules.value = { disallow: ["/post"] };
    responses.set("https://site/post/1", { ok: true, text: page(longBody) });
    expect(await fetchArticleBody("https://site/post/1")).toBeNull();
  });

  it("非 2xx → null", async () => {
    responses.set("https://site/post/1", { ok: false, text: "" });
    expect(await fetchArticleBody("https://site/post/1")).toBeNull();
  });

  it("非 HTML content-type → null", async () => {
    responses.set("https://site/post/1", { ok: true, text: page(longBody), ct: "application/pdf" });
    expect(await fetchArticleBody("https://site/post/1")).toBeNull();
  });

  it("抽取后过短（空壳/只有导航）→ null，不灌垃圾", async () => {
    responses.set("https://site/post/1", { ok: true, text: page("短") });
    expect(await fetchArticleBody("https://site/post/1")).toBeNull();
  });

  it("网络异常（unmocked）→ null（不抛）", async () => {
    expect(await fetchArticleBody("https://site/never")).toBeNull();
  });
});

describe("articleFetchEnabled（开关）", () => {
  it("默认关；=1/true 开", () => {
    expect(articleFetchEnabled()).toBe(false);
    process.env.ARTICLE_FETCH = "1";
    expect(articleFetchEnabled()).toBe(true);
    process.env.ARTICLE_FETCH = "true";
    expect(articleFetchEnabled()).toBe(true);
    process.env.ARTICLE_FETCH = "0";
    expect(articleFetchEnabled()).toBe(false);
  });
});
