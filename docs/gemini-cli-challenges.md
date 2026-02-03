# Desafios na Integração do Gemini CLI (Cloud Code Auth)

Este documento detalha os obstáculos técnicos encontrados ao tentar replicar a funcionalidade de "chat gratuito" do `gemini-cli` (Google Cloud Code) dentro do NanoClaw.

## O Objetivo
Substituir o provedor Claude Code pelo Gemini, utilizando o mesmo mecanismo de autenticação do `gemini-cli`: um fluxo OAuth que obtém tokens para a API do Google Cloud Code, teoricamente permitindo uso gratuito dentro dos limites do tier "Gemini Code Assist".

## Desafios Técnicos

### 1. Restrições de Escopo OAuth (Erro 403: restricted_client)
O Client ID extraído do Gemini CLI (`681255809395-...`) possui uma lista de permissão (allowlist) rígida de escopos.
*   **Tentativa:** Adicionar o escopo `https://www.googleapis.com/auth/generative-language` para usar a API pública do Gemini (`generativelanguage.googleapis.com`).
*   **Resultado:** Falha na autenticação com erro `restricted_client`.
*   **Consequência:** Somos forçados a usar o escopo `https://www.googleapis.com/auth/cloud-platform`, que dá acesso ao Google Cloud (GCP), mas não autoriza a API pública do Gemini (apenas Vertex AI ou Cloud Code).

### 2. Endpoints Não Documentados (Cloud Code Private API)
O `gemini-cli` e as extensões de IDE usam a API interna `https://cloudcode-pa.googleapis.com`.
*   **Tentativa:** Inferir a URL de inferência (chat) baseada em padrões da Vertex AI e RPC do Google.
    *   `/v1internal/projects/{id}/locations/us-central1/publishers/google/models/{model}:streamGenerateContent` -> **404 Not Found**
    *   `/v1internal/projects/{id}/locations/global/models/{model}:streamGenerateContent` -> **404 Not Found**
    *   `/v1internal/models/{model}:streamGenerateContent` -> **404 Not Found**
*   **Análise:** Sem realizar engenharia reversa do tráfego HTTPS (sniffing) da extensão do VS Code, é impossível adivinhar a rota exata que atua como proxy gratuito. A documentação disponível apenas referencia endpoints de quota (`retrieveUserQuota`).

### 3. Restrições no Projeto Automático (Shadow Project)
O fluxo de autenticação descobre ou cria automaticamente um projeto GCP (ex: `strange-gauge-570k4`).
*   **Tentativa:** Usar a API oficial da Vertex AI (`us-central1-aiplatform.googleapis.com`) com as credenciais obtidas.
*   **Resultado:** Erro 403 (`Vertex AI API has not been used in project... or is disabled`).
*   **Consequência:** O projeto criado automaticamente pelo Cloud Code parece ser um "projeto sombra" com permissões restritas apenas à API interna `cloudcode-pa`. Ele não permite o uso direto da Vertex AI API (que requereria billing/ativação explícita).

## Conclusão e Solução Adotada

Não conseguimos usar a "rota mágica gratuita" (`cloudcode-pa`) por falta de conhecimento do endpoint exato. Para garantir uma implementação estável e oficial, optou-se por usar a **Vertex AI API oficial**.

**Implicações para o Usuário:**
1.  O sistema agora funciona com a robustez da Vertex AI.
2.  **Requisito:** O usuário DEVE fornecer um projeto Google Cloud próprio (`GOOGLE_CLOUD_PROJECT`) onde a API Vertex AI esteja habilitada.
3.  Isso pode exigir a habilitação de faturamento (Billing) no projeto do usuário, dependendo das cotas da Vertex AI, diferindo ligeiramente da experiência "totalmente grátis" do Gemini Code Assist (que é subsidiado pelo Google via API interna).

**Possível Melhoria Futura:**
Se o endpoint exato de chat da API `cloudcode-pa` for descoberto (via sniffing de rede do VS Code), basta atualizar a constante `GEMINI_API_ENDPOINT` em `src/gemini-client.ts` para restaurar o acesso via proxy gratuito.
