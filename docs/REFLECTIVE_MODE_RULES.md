# Wendy — modo reflexivo: privacidade, limites e protocolo de risco

Status: **proposta**, 15/out/2026. **Nada disto está implementado.** Este documento não é aconselhamento clínico e **não foi revisado por um profissional de saúde mental**; a seção 8 diz o que precisa acontecer antes de o modo existir. Palavras como "deve" descrevem o comportamento exigido do produto.

## 1. O que é e o que não é
**É:** um espaço, ligado por você, para pensar em voz alta com a Wendy: valores, o que está pesando, decisões difíceis, check-ins. Ela escuta, organiza, devolve perguntas e ajuda a transformar a reflexão em um próximo passo concreto.

**Não é:** terapia, psicologia, psiquiatria, diagnóstico, tratamento, acompanhamento clínico nem serviço de emergência. A Wendy **nunca** se apresenta como psicóloga, terapeuta ou profissional de saúde, em nenhuma tela, texto ou resposta.

## 2. Ativação e consentimento
1. **Desligado por padrão.** Nenhuma conversa comum "vira" modo reflexivo sozinha, e a Wendy não conduz a conversa para ele sem convite.
2. **Ativação explícita, em tela própria**, em português claro, que diz: o que é e o que não é (seção 1); para onde vai o texto (seção 4); o que é guardado e por quanto tempo (seção 3); como pausar, apagar e sair; o que acontece se houver sinal de risco (seção 6).
3. **Consentimento por sessão curta e revogável:** um indicador visível ("Modo reflexivo ligado") fica na tela o tempo todo, com **Pausar**, **Encerrar** e **Apagar esta conversa**.
4. **Sem pressão.** A Wendy não sugere o modo para convencer você de nada e não usa expressões emocionais (personagens, tom) para empurrar uma decisão.

## 3. Privacidade e retenção
Todo conteúdo reflexivo pertence a uma classe própria, **SENSÍVEL-REFLEXIVA**, a mais restrita do produto.
- **Padrão: não guardar.** A conversa existe só durante a sessão. Guardar é uma escolha sua, por sessão, com prazo (por exemplo 7, 30 ou 90 dias), e o texto expira sozinho.
- **Nunca vira memória automaticamente.** O histórico de mensagens não é a memória pessoal. Do modo reflexivo, nenhuma frase entra em `memories` sem uma confirmação sua, item a item, com a fonte à vista.
- **Nunca aparece fora do modo.** Conversas reflexivas **não** entram em "Continuar de onde parou", "Retomar", "Agora", resumos, notificações, proatividade, compartilhamento de tela nem exportação geral. (Hoje "Continuar de onde parou" lista o texto das perguntas; o modo reflexivo precisa de exclusão total dessa lista, não apenas do botão "Ocultar textos".)
- **Nunca no ledger, nos logs ou em erros.** O ledger registra no máximo "sessão reflexiva iniciada/encerrada" (sem conteúdo). `redactSecrets`/`loggableError` continuam valendo, e o texto reflexivo não é escrito em `model_calls.input/output` (a classe SENSÍVEL-REFLEXIVA é omitida, não só mascarada).
- **Apagar de verdade.** "Apagar esta conversa" remove o conteúdo do banco; o produto avisa que **cópias que já saíram** (ver seção 4) não estão sob o controle da Wendy.
- **Exportar** um resumo para levar a um profissional é uma ação sua, explícita, gerada na hora, sem enviar a ninguém.
- **Sem promessa de sigilo absoluto.** A Wendy não diz "fica só entre nós". Diz o que de fato acontece com o texto.

## 4. Para onde o texto vai (modelo externo)
Hoje o raciocínio é feito por um modelo de terceiros (Gemini, rotulado "não é o Claude"). Logo, **o texto da reflexão sai da sua máquina**.
- A tela de ativação **diz isso com todas as letras**, e o modo só liga se você aceitar. Se recusar, o modo **não fica disponível**; não há versão "escondida".
- **Contexto mínimo:** a requisição ao modelo leva só o que você escreveu na sessão (e o que você acrescentar de propósito). Não leva e-mails, agenda, tarefas, memórias nem dados de outras áreas.
- **O que o produto não pode garantir:** como o provedor trata, retém ou usa o texto. O app deve apontar para a política do provedor e **não afirmar** garantias que não controla. Se a política não for aceitável para você, o caminho é um modelo local ou nenhum modo reflexivo (decisão sua, seção 9).

## 5. Limites de comportamento
A Wendy, neste modo, **não**:
1. **Diagnostica nem rotula** ("você tem ansiedade/depressão…"). Leituras emocionais são **hipóteses**, ditas como tais ("parece que… estou certa?"), nunca como fato, e você pode corrigi-las.
2. **Orienta medicação**: não sugere, não ajusta, não comenta doses nem interações, e não opina sobre começar ou parar remédio. Responde que isso é com médico ou farmacêutico e, se for relevante, ajuda a preparar a pergunta para a consulta.
3. **Promete resultado, cura ou "tratamento"**, nem monta "plano terapêutico".
4. **Incentiva dependência.** Sem "estou sempre aqui por você" como substituto de pessoas; incentiva vínculos humanos e apoio profissional quando fizer sentido; sessões têm duração sugerida e a Wendy propõe pausas.
5. **Valida tudo.** Não é bajuladora: discorda com respeito e pergunta o que já foi tentado.
6. **Age no mundo sem aprovação.** Não contata ninguém, não agenda consulta e não envia nada. Qualquer ação externa segue `policy.ts`: pede aprovação explícita, caso a caso.
7. **Usa o que você disse contra a sua decisão** ou para pressionar ("você disse que…") em outro contexto.

## 6. Protocolo de risco
**Princípio:** quando houver sinal de risco, o objetivo muda de "refletir" para "segurança". Para os níveis altos, **o texto é pré-escrito e revisado**, não gerado livremente pelo modelo.

### 6.1 Níveis
| Nível | Sinal (exemplos de natureza, não lista fechada) | O que a Wendy faz |
|---|---|---|
| **0** | Conversa comum | Segue normalmente |
| **1 · sofrimento** | Tristeza, ansiedade ou sobrecarga fortes, sem pensamento de se machucar | Acolhe sem diagnosticar, oferece pausa e respiração/grounding simples, lembra que pode falar com alguém de confiança ou com um profissional, **sem insistir** |
| **2 · risco elevado** | Desesperança persistente, falar em "sumir", "não aguentar mais", pensamento de morrer sem plano; violência ou abuso sofrido ou praticado, sem perigo imediato | **Para de conduzir exercícios.** Pergunta de forma direta e gentil se você está pensando em se machucar. Mostra os recursos da seção 6.3. Oferece ficar na conversa só para escutar |
| **3 · risco agudo** | Intenção, plano, meio disponível, tentativa em andamento ou perigo imediato a si ou a outra pessoa | Mensagem pré-escrita e fixa: o que fazer **agora** (ligar 192 ou 190, ou ir ao pronto-socorro mais próximo; procurar uma pessoa por perto), com os números, sem prosseguir com o conteúdo anterior |

### 6.2 Regras de execução
- **Nunca ignorar nem minimizar**, nem responder com "vai passar" ou conselho genérico.
- **Nunca discutir métodos ou meios.**
- **Sem acionamento automático de terceiros.** A Wendy **não** avisa ninguém por conta própria. Ela **pode propor** (e só com o seu "sim", por ação externa) enviar uma mensagem a um contato de confiança que **você tenha cadastrado antes**, com texto que você revisa.
- **Registro mínimo e local:** o nível e a hora, sem texto, para você ver depois se quiser; nada vai ao ledger nem a logs de terceiros.
- **Depois do nível 2 ou 3**, o modo reflexivo **não retoma sozinho** na mesma sessão; você decide se e quando voltar.

### 6.3 Recursos (Brasil), a revisar antes de ir ao ar
Números que o produto mostra em pt-BR, **a conferir e manter atualizados** (verificação periódica prevista na seção 7):
- **CVV 188** (apoio emocional e prevenção do suicídio, 24 h, gratuito) e chat em cvv.org.br.
- **SAMU 192** (urgência médica) e **190** (polícia) para perigo imediato.
- **180** (Central de Atendimento à Mulher) e **100** (violações de direitos humanos, inclusive crianças e adolescentes), quando o contexto for violência.
- **CAPS/UBS/UPA** mais próxima como serviço público de saúde mental e urgência.

### 6.4 Limites desta detecção (ditos ao usuário)
- A detecção é **imperfeita**: tem falso negativo (não perceber) e falso positivo (alarme sem necessidade). A tela de ativação **diz** isso: a Wendy não consegue garantir que perceba todo sinal de risco e não substitui ajuda humana.
- A detecção combina um verificador de padrões **determinístico** (que não depende do modelo estar disponível) com a leitura do modelo. Se o modelo falhar, o verificador de padrões continua ativo e a resposta é a **conservadora**.
- Os textos dos níveis 2 e 3 **não passam pelo modelo**: são fixos, para não variar nem alucinar.

## 7. Testes e verificação (antes de qualquer ativação)
- **Suíte de casos de risco** (pt-BR, com variações de gíria, ortografia, ironia e linguagem indireta), com o mínimo de **100% de acerto** nos exemplos explícitos de nível 3 e metas medidas e publicadas para os demais. Falha no nível 3 **bloqueia** a liberação.
- **Testes de não-regressão de limites:** diagnóstico, medicação, promessa de sigilo e bajulação devem ser **recusados** em todos os casos da suíte.
- **Testes de privacidade:** conteúdo reflexivo **não** aparece em `chat_messages` além da retenção escolhida, em `model_calls`, `memories`, ledger, logs, "Continuar de onde parou", exportação geral nem proatividade.
- **Verificação periódica dos números** da seção 6.3 e dos textos fixos.
- **Registro de falhas:** toda falha conhecida vira caso novo na suíte.

## 8. Antes de ativar: revisão humana obrigatória
Eu (a IA que escreveu este documento) **não posso certificar** que o protocolo é clinicamente adequado. Antes do modo ir ao ar, é preciso que **um psicólogo ou psiquiatra** revise: os critérios dos níveis, os textos fixos de 6.1 e 6.3, os limites da seção 5 e a suíte da seção 7. Sem essa revisão, o modo **não deve ser ativado**, nem para uso próprio.

## 9. Decisões que são suas
1. **Existir ou não:** ligar o modo reflexivo, sim ou não.
2. **Modelo externo:** aceitar enviar texto reflexivo ao provedor (seção 4), ou exigir modelo local, ou não ter o modo.
3. **Retenção padrão:** não guardar (recomendado) ou um prazo.
4. **Contato de confiança** (opcional) e o texto que a Wendy poderia **propor** enviar.
5. **Quem revisa** o protocolo (seção 8) e quando.

## 10. O que explicitamente **não** será construído
Diagnóstico automático, "triagem" de saúde mental, perfis psicológicos, qualquer uso do conteúdo reflexivo para recomendação, publicidade, proatividade ou treino, acionamento automático de terceiros, e qualquer apresentação da Wendy como profissional de saúde.
