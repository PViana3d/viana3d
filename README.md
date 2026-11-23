# Viana 3D — Gestão de impressão 3D

Aplicação para gerir uma oficina de impressão 3D: orçamentos (com PDF para o cliente), encomendas, planeamento de produção, registo de impressões, catálogo de peças, clientes, bobines de filamento, manutenção das impressoras e relatórios.

- **Endereço:** https://gestao.serras3d.pt/ — publicado pelo **Cloudflare Pages** (projeto `serras3d-gestao`, ligado a este repositório: cada envio para `main` publica a versão nova; comando `npm run build`, pasta `dist`, `NODE_VERSION=22`).
- **Domínio:** registo CNAME `gestao` → `serras3d-gestao.pages.dev` no DNS de serras3d.pt (Amen); HTTPS do Cloudflare.
- **Endereço antigo:** https://pviana3d.github.io/viana3d/ (GitHub Pages) só reencaminha para o novo, mantendo o `#…` (pasta `redirect/`, workflow *Reencaminhar endereço antigo*).
- **Dados:** Supabase, projeto `viana3d` (região Paris). Cada empresa tem os seus dados; a equipa partilha-os em tempo real.
- **Windows e Android:** é uma aplicação web instalável (PWA). Atualiza-se sozinha sempre que há uma versão nova.

## Instalar

**Windows (Edge ou Chrome):** abra o endereço, entre na conta e clique no ícone de instalar na barra de endereço (ou menu ⋯ → *Aplicações* → *Instalar este site como aplicação*). Fica no menu Iniciar e abre numa janela própria.

**Android (Chrome):** abra o endereço, entre na conta e toque em *Instalar aplicação* (ou menu ⋮ → *Adicionar ao ecrã principal*). Abre em ecrã inteiro, como uma app normal. No telemóvel, o PDF do orçamento pode ser partilhado diretamente por email ou WhatsApp.

**iPhone/iPad (Safari):** botão Partilhar → *Adicionar ao ecrã principal*.

## Contas e equipa

1. A primeira pessoa a criar conta fica como **dono** de uma empresa nova.
2. Em **Definições → Equipa**, o dono convida colegas pelo email.
3. O colega abre o endereço, escolhe *Criar conta* com esse email, confirma o email e entra diretamente na equipa.

As regras de segurança da base de dados (RLS) garantem que cada pessoa só lê e altera os dados da sua empresa, e que só o dono convida ou remove pessoas.

## Configuração (já feita, para referência)

### Supabase
- Esquema em [`supabase/schema.sql`](supabase/schema.sql) (pode voltar a correr-se no *SQL Editor* sem estragar nada).
- **Authentication → URL Configuration:** *Site URL* = `https://gestao.serras3d.pt/` e, em *Redirect URLs*, `https://gestao.serras3d.pt/**` (e o endereço antigo enquanto houver links antigos). É para aqui que apontam os links de confirmação de conta e de recuperação de palavra-passe.
- Manter ligada a confirmação de email (*Authentication → Sign In / Providers → Email → Confirm email*): é o que impede alguém de se fazer passar por um colega convidado.

### GitHub Pages
- *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
- Cada alteração enviada para `main` é publicada automaticamente pelo workflow [`.github/workflows/publicar.yml`](.github/workflows/publicar.yml).
- No plano gratuito do GitHub, o Pages só funciona com repositórios **públicos**. O código fica visível, mas os dados não: estão no Supabase, protegidos por login.

## Estrutura

| Ficheiro | O que é |
|---|---|
| `index.html` | página da aplicação |
| `app.js` | toda a lógica (orçamentos, encomendas, produção, PDF, G-code, …) |
| `styles.css` | aspeto |
| `config.js` | endereço e chave pública do Supabase |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalação como app e funcionamento sem internet |
| `scripts/build.mjs` | monta a pasta `dist/` com as bibliotecas (Supabase, jsPDF, JSZip) |
| `supabase/schema.sql` | tabelas, funções e regras de segurança |

## Desenvolver no computador

```bash
npm install
npm start        # abre em http://localhost:5173
```

## Sem internet

A aplicação abre sem ligação e mostra os dados do último acesso nesse aparelho. As alterações precisam de ligação; quando a ligação volta, os dados atualizam-se sozinhos.
