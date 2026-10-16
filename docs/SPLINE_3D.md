# Personagens 3D (Spline) — estado e como adicionar cenas

Atualizado em 15/out/2026. **A estrutura está pronta; NENHUMA cena está configurada, então hoje nada de 3D carrega.** Tudo é local, não commitado.

## O que existe
- **Dependências (oficiais, versões exatas):** `@splinetool/react-spline@4.1.0` e `@splinetool/runtime@2.0.85` em `web/package.json`. Trouxeram 8 pacotes novos (com `blurhash`, `thumbhash`, `on-change`, `lodash.debounce`, `react-merge-refs`, `semver-compare`) e não alteraram nenhuma versão existente. O `npm audit` aponta 17 vulnerabilidades **antigas** (cadeia do CopilotKit); nenhuma é dos pacotes novos.
- **Registro:** `web/lib/characters.ts` ganhou `scene?:` opcional por personagem. Sem `scene`, o personagem é só 2D (como era). O retrato 2D é **sempre** a reserva.
- **Regras puras:** `web/lib/scene3d.ts`. O endereço da cena só é aceito se for exatamente `https://prod.spline.design/<id>/scene.splinecode` (sem credenciais, porta, query, fragmento nem caminhos extras). Qualquer outro é ignorado, **nunca carregado**. O endereço só vem do registro: nunca de um modelo, mensagem ou servidor.
- **Quando carrega (todas as condições):** há cena permitida **e** a pessoa ligou "Personagens em 3D" (desligado por padrão, por dispositivo) **e** não há `prefers-reduced-motion` **e** o personagem está visível **e** não há aprovação pendente **e** o navegador não pediu "economizar dados". Falhando qualquer uma, fica o 2D e **nada é pedido ao Spline**.
- **Componente:** `web/components/concierge/character-3d.tsx`: carregado sob demanda (`next/dynamic`, sem SSR), por cima do retrato 2D, com `Boundary`: se a cena falhar, a camada 3D some e o 2D continua.
- **Opção na tela:** o botão "Personagens" ganha "Personagens em 3D" **somente se houver pelo menos uma cena configurada** (sem cena, a opção nem aparece).

## Verificado (15/out/2026)
- 10 testes (`tests/unit/scene3d.test.ts`), sem rede. A validação do endereço foi mutada: quando removo cada checagem **junto com** a igualdade estrita final, os testes falham em todos os casos; sozinhas, são equivalentes (defesa em profundidade).
- No navegador, com uma cena **local inexistente** (galeria `/dev/personagens3d`, sem nenhum servidor de terceiros): a cena falhou, o erro foi capturado pelo `Boundary`, a camada 3D saiu, o retrato 2D ficou idêntico (48×48), sem overflow.
- Na Home real com a opção desligada: nenhum canvas, nenhum pedido a hosts externos. No build de produção, os 8 chunks do Spline (até 178 KB cada) **não** estão no HTML inicial da Home.
- **Não verificado:** uma cena real do Spline (nenhuma foi fornecida, e eu não contactei o Spline), o desempenho/bateria com WebGL real, e o comportamento em Safari/iOS.

## Como adicionar uma cena (você faz o 1 a 3)
1. No Spline, crie ou escolha uma cena **sua ou com licença que permita uso comercial** (modelos da comunidade são de terceiros: a sua declaração de direitos sobre as imagens dos personagens atuais **não** cobre isso).
2. Publique: **Export → Code / Viewer → Public URL**. O endereço deve ter o formato `https://prod.spline.design/<id>/scene.splinecode`.
3. Me envie o endereço e o personagem a que ele pertence.
4. Eu o coloco em `scene:` no registro (`web/lib/characters.ts`). O endereço **é público** (qualquer pessoa que o tenha pode abri-lo); não ponha nada sigiloso na cena.

## Privacidade e riscos
- Com 3D ligado, o **navegador** da pessoa baixa o código e a cena dos servidores do Spline (um terceiro): IP e dados de navegação ficam expostos a eles. Por isso é opcional e desligado por padrão.
- Não há CSP configurada no projeto hoje; se for adicionada, `prod.spline.design` precisa estar liberado em `connect-src` e, conforme a cena, em `img-src`/`media-src`.
- Cenas pesam alguns MB e usam WebGL (bateria, GPU). Só uma por vez, sob demanda.
- O personagem continua **decorativo** (`aria-hidden`) e **subordinado** à segurança: parado enquanto há aprovação pendente.

## Fora desta versão
Cena por **contexto** (a habilidade em execução: tarefas, agenda, sites, memória). Hoje o tema é só o **humor** que a Wendy já lê, com as 6 categorias existentes; o tema por assunto não existe e não será inferido do texto.
