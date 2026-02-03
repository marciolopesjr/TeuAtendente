# Relatório de Implementação: Integração Gemini CLI

Este relatório detalha a implementação do uso do `gemini-cli` para fornecimento de LLM no projeto OpenClaw, com o objetivo de facilitar sua reutilização em outros projetos.

## 1. Visão Geral da Arquitetura

A integração não utiliza a API pública do Vertex AI ou AI Studio diretamente com uma chave de API padrão. Em vez disso, ela mimetiza o comportamento da ferramenta de linha de comando `gemini` (Google Cloud Code), utilizando um fluxo de autenticação OAuth 2.0 para obter credenciais que permitem acesso às APIs internas do Google Cloud Code (e.g., `cloudcode-pa.googleapis.com`).

A solução é composta por três partes principais:
1.  **Extensão de Autenticação (`extensions/google-gemini-cli-auth`)**: Responsável por obter e gerenciar tokens de acesso.
2.  **Registro do Provider**: Integração com o sistema de modelos do OpenClaw.
3.  **Consumo da API**: Uso dos tokens para chamadas de inferência e cotas.

## 2. Mecanismo de Autenticação

O núcleo da implementação reside em `extensions/google-gemini-cli-auth/oauth.ts`.

### Fluxo de Obtenção de Credenciais
O sistema tenta obter credenciais de duas formas:

1.  **Extração Local**: Tenta ler o arquivo `oauth2.js` da instalação local do `gemini-cli` (geralmente instalado via homebrew ou npm) para roubar as credenciais (`clientId` e `clientSecret`) embutidas na ferramenta oficial.
2.  **Fluxo OAuth 2.0 (PKCE)**: Se necessário, inicia um fluxo de login completo:
    *   Gera um par PKCE (verifier/challenge).
    *   Inicia um servidor HTTP local na porta `8085` (`http://localhost:8085/oauth2callback`).
    *   Abre o navegador do usuário para `accounts.google.com` com os escopos:
        *   `https://www.googleapis.com/auth/cloud-platform`
        *   `https://www.googleapis.com/auth/userinfo.email`
        *   `https://www.googleapis.com/auth/userinfo.profile`
    *   Recebe o `code` de autorização no servidor local.
    *   Troca o `code` por `access_token` e `refresh_token`.

### Descoberta de Projeto (Project Discovery)
Após a autenticação, o sistema precisa associar o usuário a um projeto do Google Cloud. Isso é feito chamando endpoints internos:
*   `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`: Verifica o estado atual e tiers permitidos.
*   `https://cloudcode-pa.googleapis.com/v1internal:onboardUser`: Realiza o onboarding do usuário no serviço Gemini (Code Assist).

## 3. Integração e Configuração

### Extensão (`extensions/google-gemini-cli-auth/index.ts`)
A extensão registra o provedor no OpenClaw:
*   **Provider ID**: `google-gemini-cli`
*   **Configuração**: Define variáveis de ambiente esperadas (`OPENCLAW_GEMINI_OAUTH_CLIENT_ID`, etc.).
*   **Patch de Configuração**: Injeta o modelo padrão `google-gemini-cli/gemini-3-pro-preview` na configuração do agente.

### Tratamento de Modelos (`src/agents/pi-embedded-runner/google.ts`)
O código contém lógica específica para lidar com idiossincrasias dos modelos Gemini via essa API:
*   **Sanitização**: Limpeza de schemas de ferramentas (tools) para remover keywords não suportadas pelo Gemini.
*   **Ordenação de Turnos**: O Gemini exige estrita alternância User/Model. O código em `pi-embedded-runner` garante isso, inserindo mensagens de bootstrap se necessário.

## 4. Consumo da API (Inferência)

Embora a chamada exata de inferência (chat completion) esteja abstraída nas bibliotecas core (`@mariozechner/pi-coding-agent`), o padrão de uso é claro através do arquivo de cotas:

*   **Endpoint de Cotas**: `src/infra/provider-usage.fetch.gemini.ts` faz chamadas para `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`.
*   **Autenticação**: Header `Authorization: Bearer <access_token>`.

A inferência segue o mesmo padrão, utilizando a API `cloudcode-pa.googleapis.com` (Cloud Code Private API) em vez da API pública do Vertex AI. Isso permite o uso gratuito (Free Tier) associado ao Gemini Code Assist/Cloud Code, contornando a necessidade de faturamento ativo em alguns casos.

## 5. Guia de Reutilização

Para portar essa funcionalidade para outro projeto, você precisará replicar os seguintes componentes:

1.  **Módulo OAuth**: Copie e adapte `extensions/google-gemini-cli-auth/oauth.ts`.
    *   Dependências: `node:http`, `node:crypto`, `open` (para abrir navegador).
    *   Essencial manter a lógica de servidor local para callback e a descoberta de projeto (`discoverProject`).

2.  **Cliente API**: Implemente um cliente HTTP que use o `access_token` obtido.
    *   Base URL: `https://cloudcode-pa.googleapis.com`
    *   Headers:
        *   `Authorization: Bearer <token>`
        *   `User-Agent`: Mimicar o agente do Google (ex: `google-api-nodejs-client/9.15.1`) pode ser necessário.

3.  **Extração de Credenciais (Opcional)**: Se quiser suportar o uso das credenciais do `gemini-cli` já instalado no sistema do usuário, copie a lógica de `extractGeminiCliCredentials`.

4.  **Tratamento de Dados**: Se for usar Function Calling, atente-se às restrições de schema JSON do Gemini (remova `additionalProperties`, etc.), conforme visto em `src/agents/pi-embedded-runner/google.ts`.

## Arquivos de Referência

*   `extensions/google-gemini-cli-auth/oauth.ts`: Lógica completa de Auth.
*   `extensions/google-gemini-cli-auth/index.ts`: Definição do plugin.
*   `src/infra/provider-usage.fetch.gemini.ts`: Exemplo de chamada de API.
*   `src/agents/pi-embedded-runner/google.ts`: Sanitização de input/output.
