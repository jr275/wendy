/** DEV ONLY — Markdown security cases (reserved example domains). The browser check blocks every non-local request, so nothing leaves the machine. */
export const CASES: { id: string; md: string }[] = [
  { id: "text", md: "Olá **negrito**, _itálico_ e `código`.\n\n- um\n- dois\n\n## Título" },
  { id: "link", md: "Veja [a documentação](https://example.com/docs)." },
  { id: "md-image", md: "![logo externo](https://tracker.example.net/pixel.png)" },
  { id: "html-image", md: '<img src="https://tracker.example.net/a.png" onerror="alert(1)" alt="x">' },
  { id: "js-link", md: "[clique](javascript:alert(1))" },
  { id: "script", md: "<script>alert(1)</script>Texto depois" },
  { id: "iframe", md: '<iframe src="https://evil.example.org/"></iframe>Texto' },
  { id: "handler", md: '<b onclick="alert(1)">negrito com handler</b>' },
  { id: "data-image", md: "![dados](data:image/png;base64,iVBORw0KGgo=)" },
];
