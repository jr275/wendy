# Wendy multimodal — auditoria e plano técnico

Data: 15/out/2026. Branch `wendy/phase-1-cognitive-core`, HEAD `23b04db`, 131 entradas no working tree (tudo não commitado). **Só a fatia 1 (voz) foi implementada; veja a atualização logo abaixo.** Fontes na seção 3; o que não foi possível confirmar está marcado.

> **Atualização (15/out/2026) — fatia 1, voz:** implementada com a Web Speech API (STT e TTS, pt-BR), máquina de estados, cancelamento, barge-in e retorno ao texto, integrada à conversa `main`. **STT NÃO validado com microfone real.** Veja `docs/VOICE_VALIDATION.md`. As demais fases (B3, rotina diária, Spline, mapas) continuam em planejamento.

## 1. Auditoria: o que é real, simulado ou inexistente
| Área | Estado | Evidência |
|---|---|---|
| Conversa, streaming, histórico | **Real** | AG-UI: `src/agent/server.ts` → `run.ts`; `chat_messages`; `WendyRunner` no web |
| Raciocínio | **Real, mas não é o Claude** | `reasoner.ts`: Gemini (MVP), rotulado na interface |
| Memória, evidências, validação | **Real** | pipeline de claims, `memories`, ledger com hash encadeado |
| Permissões e aprovações | **Real** | `permissions/policy.ts` (EXTERNAL/DESTRUCTIVE/PAYMENT nunca automáticos) |
| Habilidades (skills) | **Real** | `learn-about-me`, `task-management`, `document-analysis`, `web-research`, `voice-concierge` |
| **Voz** | **Só SIMULADA, e é telefone, não conversa** | `src/voice/mock.ts` (`MockVoiceProvider`, `simulated = true`); `provider.ts`: "No real provider exists yet". Não há captura de microfone, STT nem TTS na interface |
| **Agendamento** | **Existe só como ciclos de processo** | `workerCli.ts`: `setInterval` (30 s, Google 5 min, Search Console 1 h). **Não há agendamento por data/hora, fuso, nem idempotência por dia** |
| Canais de entrega externos | **Inexistentes** | só o app (Home/"Agora"); ver `PROACTIVITY_DESIGN.md` |
| Mercado/B3/TradingView | **Inexistente** | nenhuma ocorrência no código |
| Mapas | **Inexistente** | idem |
| Citações / desafio diário | **Inexistente** | idem |
| 3D (Spline) | **Estrutura pronta, sem cenas** | `docs/SPLINE_3D.md`; nada carrega hoje |

**Detecção de recursos no navegador do app (Chromium, `localhost`):** `SpeechRecognition` e `speechSynthesis` existem; há 6 vozes `pt-BR` **locais** (Eddy, Flo, Grandma, Grandpa, Luciana, Reed); `getUserMedia`, `MediaRecorder` e WebGL2 existem; a permissão de **microfone está negada neste painel**, então **STT não pode ser testado aqui**.

## 2. Reaproveitado (nada paralelo)
Conversa única (thread `main`), `chat_messages`, validação de evidências, permissões/aprovações, ledger, `redactSecrets`/`maskCardData`, `connected_sources`, o worker, o modelo de eventos e a esteira evento → insight → "Agora", `config/*-scope.json` (negar por padrão), `docs/SPLINE_3D.md` e a camada de personagens/humor.

## 3. Documentação oficial: o que foi verificado (e o que não)
- **TradingView não tem API pública de dados de mercado.** O que existe: **Advanced Charts** (biblioteca para você hospedar e **alimentar com a sua própria fonte de dados**; gratuita só para empresas, uso público, com atribuição, mediante solicitação), **Trading Platform** (para corretoras, licença paga) e **Lightweight Charts** (código aberto, Apache 2.0, recebe dados seus). [TradingView](https://www.tradingview.com/free-charting-libraries/), [documentação](https://br.tradingview.com/charting-library-docs/latest/api). *Parte da informação vem de blogs de terceiros; confirme com a TradingView.*
- **Alertas com webhook da TradingView:** exigem **plano pago e autenticação em dois fatores**; **uma URL por alerta**; limites e plano mínimo **divergem entre as fontes**. [Referência de terceiros](https://crosstrade.io/blog/tradingview-plan-for-webhook-alerts). *Não confirmado na página oficial.* Não há raspagem de sessões autenticadas neste plano.
- **Cotações da B3 (fonte autorizada, plano gratuito):** a brapi.dev informa **atraso de ~30 min (as fontes divergem: 15 ou 30)**, 15.000 requisições/mês, **1 ativo por requisição**, histórico de **3 meses**; token obrigatório (exceto PETR4, VALE3, MGLU3, ITUB4). [Preços](https://brapi.dev/pricing.md), [FAQ](https://brapi.dev/faq/o-plano-gratuito-tem-limitacoes-importantes). Dado **em tempo real** e licença de redistribuição são produto pago da B3 ou de um vendor autorizado: **não verificado**.
- **Voz em tempo real (Gemini Live API):** o navegador pode falar direto por WebSocket, mas a documentação recomenda **proxy ou tokens efêmeros** (nunca a chave no cliente); o modelo recomendado era `gemini-3.1-flash-live-preview`. [Documentação](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket). **Não verificado:** preço por áudio e suporte a pt-BR.
- **Web Speech API:** `SpeechRecognition` tem suporte em navegadores baseados em Chromium (e parcial em Safari); o reconhecimento costuma ser **feito em servidor do fabricante** (privacidade), com reconhecimento **no dispositivo** em evolução ([MDN](https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static)). **pt-BR não confirmado em fonte oficial.**
- **Google Maps — Photorealistic 3D Tiles:** exige **atribuição do Google**, **proíbe medir** altura/distância/elevação a partir do 3D (não é grau de levantamento), **proíbe cache/armazenamento** do conteúdo; a cobrança é por **requisição de "root tile"**. [Blog oficial](https://mapsplatform.google.com/resources/blog/photorealistic-3d-tiles-now-preview-updated-daily-quotas). **Não verificado:** cobertura no Brasil e preço atual.

## 4. Arquitetura proposta e ordem (uma fatia por vez, cada uma com portão)
Princípio: **um módulo puro e testável por área**, interface tipada para cada provedor, segredos só no servidor, e **nenhum mock apresentado como real**.

### Fase 1 — Voz conversacional (portão: decisão de provedor)
- **Interfaces:** `SpeechRecognitionProvider`, `SpeechSynthesisProvider`, `VoiceSessionManager`, `VoiceState` (`IDLE | LISTENING | TRANSCRIBING | THINKING | SPEAKING | INTERRUPTED | ERROR`), `VoicePreferences`. Máquina de estados **pura** em `web/lib/voice/` (testada sem navegador): barge-in (interrompe a fala ao detectar a sua), cancelamento imediato, sem fala concorrente, sem laço de microfone (o microfone fecha enquanto ela fala), sem resposta duplicada (chave por turno).
- **Mesmo contexto:** a transcrição entra como **mensagem do usuário na thread `main`** (a mesma pipeline, a mesma memória, as mesmas aprovações). A voz **não** aprova nada: continua valendo `policy.ts`. Nenhum segundo agente.
- **Provedor v1 recomendado:** **Web Speech API** (STT) + **`speechSynthesis`** (TTS, vozes pt-BR locais já detectadas): sem credencial e sem custo, mas qualidade variável e **STT depende do navegador/servidor do fabricante**. **v2:** Gemini Live (mesma família do raciocínio atual), via **token efêmero emitido pelo servidor**, após conferir preço e pt-BR.
- **UX:** botão de microfone na conversa, transcrição visível e **editável antes de enviar**, estado em palavras, Parar sempre à mão, texto 100% como fallback.
- **Aceite:** testes da máquina de estados (interrupção, timeout, falha, duplicidade); **teste real do provedor configurado no seu navegador, com o seu microfone** (eu não consigo: a permissão está negada neste painel). Só então "voz real".

### Fase 2 — Mercado B3 (portão: fonte de dados, licença e custo)
- **TradingView:** não como fonte. Opção de **exibir** gráficos (Lightweight Charts, Apache 2.0) com dados nossos; webhooks de alerta só se você tiver plano pago, como **entrada** opcional.
- **Pipeline separado da UI** em `src/market/`: normalização com `dataTimestamp` explícito, baselines robustos (mediana/MAD, EWMA, z-score robusto), volume relativo, ATR/volatilidade realizada, comparação com índice. **Sem modelo complexo** sem prova em validação temporal (walk-forward, sem look-ahead).
- **Contrato `MarketSignal`** apenas com métricas que os dados sustentam; **deduplicação, cooldown por ativo, expiração, limiares configuráveis e registro no ledger**. Texto do alerta separa **anomalia detectada**, **hipótese** e **decisão** (esta nunca é da Wendy); mostra fonte, **idade do dado** e, quando atrasado, **"atrasado"**.
- **Somente monitoramento.** Nenhuma ordem, nenhuma conexão de execução, nenhum preço-alvo ou probabilidade inventados. Linguagem sem recomendação de compra/venda (o enquadramento regulatório brasileiro para recomendação de investimento **não foi avaliado** aqui: confirme com quem entende antes de ampliar).
- **Limite real do plano gratuito:** dado atrasado (~30 min) e histórico de 3 meses (~63 pregões): **suficiente para baselines diários, insuficiente para intradiário em tempo real e marginal para baselines longos**.

### Fase 3 — Rotina diária (portão: agendador + canal)
- **Agendador:** adicionar uma tabela de rotinas (usuário, horário, fuso `America/Sao_Paulo`, ativo/pausado) e uma checagem **no ciclo do worker** que dispara **uma vez por (usuário, data)** (chave única = idempotência), com recuperação sem duplicar. **Nenhum temporizador no navegador.** Requer **migration** (autorização sua).
- **Entrega real hoje:** só **dentro do app** (cartão no "Agora"). Notificação externa **não existe**; não será declarada.
- **Peterson:** tabela de citações **verificadas** (texto, fonte primária/URL, data de verificação, uso). **A Wendy não gera citações**: se não houver uma verificada e adequada, mostra uma **paráfrase claramente rotulada, sem aspas**. Trechos curtos; sem repetir as recentes. O banco inicial precisa ser **curado por você ou verificado por fonte**.
- **Desafio de ML:** gerado pelo raciocínio (Gemini, rotulado), rodízio entre os 9 temas, **sem repetir** (hash/tema recente), resposta **retida até a sua tentativa**; correção com derivação, pressupostos, contraexemplos e **referências que você pode conferir**. Risco: o modelo pode errar uma derivação; a correção vem **rotulada como gerada por modelo**.

### Fase 4 — Spline
Estrutura já feita. Falta: **cenas suas** (licença), ícones 3D reutilizáveis por contexto (voz, mercado, mapa, tarefas), um limite de **1 cena simultânea**, e medição de bundle/carregamento com uma cena real.

### Fase 5 — Mapas (portão: chave, billing, cobertura)
- v1 **2D/vetorial inclinado** (Maps JavaScript API) + **Places API (New)** por proxy no servidor; 3D fotorrealista **só se** a cobertura do local existir (a verificar) e com atribuição, **sem cache e sem medições**.
- **Relevância contextual:** o mapa só abre quando a conversa é **sobre** um lugar (não em menção incidental), com fechar, links e **fallback em lista**.
- **Privacidade:** coordenadas/endereços **só** do que você pediu, nunca endereços pessoais por padrão; chave do Maps JS **restrita por domínio/API** (ela é visível no cliente por natureza); chaves de Places/Geocoding **só no servidor**.

## 5. Riscos e custos (resumo)
Qualidade do STT em pt-BR e privacidade (áudio vai a um terceiro); latência de voz; dados de mercado atrasados e licença de redistribuição; **risco financeiro e de linguagem** em alertas; cobrança do Google Maps por requisição; direitos autorais de citações; modelo gerando erro técnico nos desafios; segredos só no servidor; **nada** disto roda sem o worker/agente ligados no seu Mac (ou hospedados).

## 6. Decisões e bloqueios (são seus)
1. **Voz:** começar com Web Speech + TTS local (sem custo, qualidade variável) ou ir direto ao Gemini Live (custo e pt-BR a verificar)?
2. **B3:** qual fonte de dados e licença (a gratuita é atrasada); você tem plano pago do TradingView (só serviria para webhook)?
3. **Rotina diária:** autoriza a **migration** do agendador? Quem cura as citações do Peterson?
4. **Mapas:** você cria a chave do Google Maps (billing) e define o orçamento?
5. **Spline:** os endereços das cenas.
6. **Referência visual** (imagem do assistente com avatar humano realista): tratar como inspiração de layout (barra lateral, avatar com nome/papel, ações rápidas). Um **rosto humano realista** traz questões de identidade e "vale da estranheza"; a Wendy hoje usa personagens estilizados, e eu **não** copio o produto de ninguém.
