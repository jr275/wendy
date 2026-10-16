import { notFound } from "next/navigation";
import { SafeMarkdown } from "@/components/concierge/markdown";

/**
 * DEV ONLY — how a long, structured answer reads: headings, nested lists, a table, code, a quote, a long
 * unbroken link. Rendered with the same component and wrapper class the conversation uses. Fictitious text.
 */
const MD = `## Resumo do que encontrei

Os números do site **caíram 8%** na última semana, mas o *volume absoluto* continua alto. Em resumo:

1. A queda concentrou-se em **duas páginas**.
2. A posição média quase não mudou (8,2 contra 8,0).
3. Não há evidência de causa externa:
   - nenhuma mudança de site registrada
   - nenhum e-mail sobre o assunto
   - sem atualização conhecida do Google

### Comparação por página

| Página | Cliques (7 dias) | Variação |
|---|---:|---:|
| /imoveis | 12.480 | -43% |
| /aluguel/mogi-guacu | 3.205 | -54,6% |
| /comprar | 28.910 | +2% |

> Uma queda de 54% numa página pequena pode ser só volume baixo. Confirme antes de agir.

Para conferir você mesmo, o comando é \`SELECT * FROM search_metric_windows\`, ou em bloco:

\`\`\`sql
SELECT key, clicks, impressions
FROM search_metric_windows
WHERE dimension = 'page'
ORDER BY clicks DESC
LIMIT 10;
\`\`\`

Mais detalhes em [a documentação do Search Console](https://example.com/search-console/help) e neste link longo sem espaços: https://example.com/um/caminho/muito/longo/que/nao/quebra/naturalmente/e/poderia/estourar/a/largura/do/balao?parametro=valor&outro=valor

---

**Próximo passo sugerido:** abrir as duas páginas e comparar com o mês anterior.`;

export default function RichMarkdown() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-3xl p-6">
      <p className="eyebrow">Desenvolvimento · texto fictício</p>
      <h1 className="display mt-2 text-3xl">Resposta longa, como a conversa a mostra</h1>
      <div className="wendy-answer mt-6 text-body leading-relaxed text-ink">
        <SafeMarkdown content={MD} />
      </div>
    </main>
  );
}
