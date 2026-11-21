# Publicar na Vercel, só pelo navegador

Tudo pelo site, sem terminal. Leva uns 10 minutos.

## 1. Vercel: importar o projeto
1. Entre em **vercel.com** → **Sign up / Log in** com a sua conta do **GitHub**.
2. **Add New… → Project** → escolha o repositório **mtsm-capital** → **Import**.
3. Em **Root Directory**, clique em **Edit** e escolha a pasta **`backend`**.
4. Ainda nessa tela, abra **Environment Variables** e crie duas variáveis
   (para gerar os valores, use um gerador de senha, ex.: o do seu navegador, com 32 caracteres):
   - `CRON_SECRET` = um texto aleatório longo
   - `SETUP_TOKEN` = outro texto aleatório longo (é o "código de instalação"; guarde, vai usar no passo 3)
5. **Deploy**. O primeiro deploy pode dar aviso de banco ausente: tudo bem, o passo 2 resolve.

## 2. Banco de dados (Neon, grátis)
1. No projeto, aba **Storage** → **Create Database** → **Neon (Serverless Postgres)** → **Continue**.
2. Região: a mais próxima do Brasil disponível → **Create** → marque **Production** e **Preview** → **Connect**.
   Isso cria a variável `DATABASE_URL` no projeto.
3. Aba **Deployments** → no último deploy, menu **⋯** → **Redeploy**.
   Neste deploy as tabelas são criadas sozinhas (as migrações rodam no build).

## 3. Primeiro acesso
1. Abra o endereço do projeto (ex.: `https://mtsm-capital.vercel.app`).
2. Aparece **Instalar o sistema**: digite o `SETUP_TOKEN`, seu nome, e-mail e uma senha (mín. 10 caracteres).
3. Pronto, você é o administrador. Depois disso a instalação fica bloqueada para sempre.
4. **Pessoas da casa** → cadastre Marcos, Thaís, Sara e Maria.
5. **Ajustes → Usuários → + Novo usuário** para cada uma (e-mail, apelido "Gastadora", ligada à pessoa,
   senha provisória; marque **Responsável** na Thaís). Passe a senha pessoalmente.
6. **Combinados → Regras**: defina o valor das multas (começam em R$ 0,00).

## Atualizações
Cada vez que o código novo chegar ao GitHub, a Vercel publica sozinha e aplica as migrações do banco.

## Segurança
- Nunca mostre em print o `SETUP_TOKEN`, o `CRON_SECRET` nem a URL do banco.
- Depois de instalar, pode apagar o `SETUP_TOKEN` na Vercel (Settings → Environment Variables).
