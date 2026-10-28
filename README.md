# Viana 3D — Gestão de impressão 3D

Aplicação para gerir uma oficina de impressão 3D: orçamentos (com PDF para o cliente), encomendas, planeamento de produção, registo de impressões, catálogo de peças, clientes, bobines de filamento, manutenção das impressoras e relatórios.

Corre num **Raspberry Pi** em sua casa ou na oficina: a aplicação e os dados ficam no Pi. O acesso pela internet é feito com o **Tailscale Funnel**, que dá um endereço `https://…ts.net` fixo e gratuito, sem mexer no router. No Windows e no Android instala-se como uma app normal (PWA).

```
Telemóvel / PC  ──https──▶  Tailscale Funnel  ──▶  Raspberry Pi
                                                     └─ PocketBase (porta 8090)
                                                        ├─ páginas da aplicação
                                                        ├─ base de dados (SQLite)
                                                        └─ cópias de segurança diárias
```

---

## Instalação no Raspberry Pi 3

### Do que precisa
- Raspberry Pi 3 (B ou B+) com fonte de alimentação oficial (5 V, 2,5 A).
- Cartão microSD de 16 GB ou mais, de boa marca (de preferência "A1"/"A2" ou "High Endurance").
- Cabo de rede para o router (recomendado; também funciona por Wi-Fi).
- Um computador com o [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
- Uma conta gratuita no [Tailscale](https://login.tailscale.com/start) (pode entrar com Google ou Microsoft).

### 1. Preparar o cartão SD
No Raspberry Pi Imager:
1. **Dispositivo:** Raspberry Pi 3.
2. **Sistema operativo:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.
3. **Armazenamento:** o cartão SD.
4. Nas **definições de personalização** (o Imager pergunta antes de gravar):
   - Nome do aparelho (hostname): `viana3d`
   - Utilizador e palavra-passe: à sua escolha (ex.: `pedro`)
   - Wi-Fi: só se não usar cabo
   - Fuso horário `Europe/Lisbon`, teclado `pt`
   - **Serviços / Acesso remoto: ativar SSH** com palavra-passe
5. Grave, coloque o cartão no Pi, ligue o cabo de rede e a alimentação. Espere 2–3 minutos.

### 2. Entrar no Pi a partir do computador
No Windows abra o **PowerShell** (no Mac/Linux, o Terminal) e escreva:
```
ssh pedro@viana3d.local
```
(troque `pedro` pelo utilizador que escolheu; à primeira pergunta responda `yes` e depois escreva a palavra-passe).
Se `viana3d.local` não funcionar, veja o IP do Pi na página do router e use `ssh pedro@192.168.1.xx`.

### 3. Instalar a aplicação
Ainda no PowerShell, já dentro do Pi, cole este comando:
```
curl -fsSL https://raw.githubusercontent.com/PViana3d/viana3d/main/pi/instalar.sh | sudo bash
```
O instalador:
1. atualiza o sistema e liga as atualizações de segurança automáticas;
2. instala o PocketBase (servidor e base de dados) e a aplicação;
3. pede um **email e palavra-passe de administração** (conta técnica para o painel e cópias de segurança — guarde-a bem);
4. instala o Tailscale e mostra **um link**: abra-o no computador e entre na sua conta Tailscale;
5. se aparecer **outro link para ativar o Funnel**, abra-o e confirme;
6. no fim mostra o **endereço da aplicação**, do género `https://viana3d.tail1234.ts.net/`.

### 4. Desligar a expiração da chave no Tailscale (importante)
Por defeito o Tailscale pede para voltar a autenticar o aparelho de 180 em 180 dias, e o endereço deixaria de funcionar.
Em [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines) → máquina **viana3d** → menu `⋯` → **Disable key expiry**.

### 5. Primeira utilização
Abra o endereço da aplicação. Como ainda não há contas, aparece a **Configuração inicial**: crie a conta do **dono**.
Depois, em **Definições**:
- preencha os dados da empresa e o logótipo (aparecem no PDF dos orçamentos);
- em **Equipa**, adicione os colegas (nome, email e uma palavra-passe inicial que lhes entrega).

---

## Instalar a app no Windows e no Android
- **Windows (Edge ou Chrome):** abra o endereço `https://…ts.net`, entre e clique no ícone de instalar na barra de endereço (ou menu `⋯` → *Aplicações* → *Instalar este site como aplicação*). Fica no menu Iniciar.
- **Android (Chrome):** abra o endereço, entre e toque em *Instalar aplicação* (menu `⋮`). Os PDFs podem ser partilhados diretamente por email ou WhatsApp.
- **iPhone/iPad (Safari):** Partilhar → *Adicionar ao ecrã principal*.

Use sempre o endereço `https://…ts.net`, também dentro da oficina. Se a internet falhar, na rede local a aplicação continua acessível em `http://viana3d.local:8090/` (sem instalação como app).

---

## Manutenção

| Tarefa | Como |
|---|---|
| **Atualizações da aplicação** | Automáticas todas as noites (04:30). Para atualizar já: `sudo viana3d-atualizar` |
| **Cópias de segurança** | Automáticas todos os dias às 03:00, guarda as últimas 14 (no próprio cartão SD). |
| **Guardar cópias fora do Pi** | Painel técnico `https://…ts.net/_/` → *Settings* → *Backups* → descarregar. Faça-o pelo menos uma vez por mês e guarde no computador ou na nuvem. |
| **Repor uma cópia** | Painel técnico → *Settings* → *Backups* → *Restore*. |
| **Estado do servidor** | `sudo systemctl status viana3d` · registos: `sudo journalctl -u viana3d -n 50` |
| **Reiniciar** | `sudo systemctl restart viana3d` |
| **Endereço público** | `tailscale funnel status` |

### Recuperar o acesso do dono
Se o dono se esquecer da palavra-passe: entre no painel técnico `https://…ts.net/_/` com a conta de administração → *Collections* → **users** → abra a conta do dono → defina uma nova palavra-passe.

Se se esquecer também da conta de administração, no Pi:
```
sudo systemctl stop viana3d
sudo -u viana3d /opt/viana3d/pocketbase superuser upsert O_SEU_EMAIL NOVA_PALAVRA_PASSE --dir=/opt/viana3d/pb_data
sudo systemctl start viana3d
```

### Cartão SD avariado
Grave um cartão novo (passos 1–4), instale de novo e reponha a última cópia de segurança que guardou fora do Pi.

---

## Segurança
- Não há registo público de contas: só o dono cria contas para a equipa.
- Cada pessoa só altera a sua própria conta; ninguém se promove a dono; só o dono redefine palavras-passe ou remove pessoas.
- Tentativas repetidas de entrar são travadas pelo servidor (limite de pedidos).
- O Pi não tem portas abertas no router: só o Tailscale Funnel encaminha o `https` para a aplicação. O SSH só é acessível na rede local e nos seus próprios aparelhos ligados ao Tailscale.
- As atualizações de segurança do sistema instalam-se sozinhas.

---

## Para quem desenvolve

| Pasta / ficheiro | O que é |
|---|---|
| `index.html`, `app.js`, `styles.css` | a aplicação (orçamentos, encomendas, produção, PDF, G-code, …) |
| `config.js` | endereço do servidor (vazio = o próprio Pi) |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalação como app e funcionamento sem internet |
| `pb/pb_migrations/` | estrutura da base de dados e regras de acesso |
| `pb/pb_hooks/` | rotas próprias (configuração inicial) |
| `pi/` | `instalar.sh`, `atualizar.sh`, versão do PocketBase |
| `scripts/build.mjs` | monta `dist/viana3d-pi.zip` |
| `.github/workflows/publicar.yml` | em cada envio para `main`, publica o pacote na versão `pi-latest` |

Testar no computador (com o [PocketBase](https://github.com/pocketbase/pocketbase/releases) descarregado para a pasta do projeto):
```bash
npm install
node scripts/build.mjs
./pocketbase serve --publicDir=dist/web --hooksDir=pb/pb_hooks --migrationsDir=pb/pb_migrations --automigrate=false
# abrir http://127.0.0.1:8090
```
