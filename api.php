<?php
declare(strict_types=1);

session_set_cookie_params([
    'lifetime' => 0, 'path' => '/', 'httponly' => true,
    'samesite' => 'Lax', 'secure' => !empty($_SERVER['HTTPS']) || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https',
]);
session_start();
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function out($data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $code = 400): never { out(['error' => $msg], $code); }

// Em producao o banco fica fora da pasta publica (../slom-data); localmente usa ./data
$dir = is_dir(__DIR__ . '/../slom-data') ? realpath(__DIR__ . '/../slom-data') : __DIR__ . '/data';
if (!is_dir($dir)) mkdir($dir, 0750, true);
if (!file_exists($dir . '/.htaccess')) file_put_contents($dir . '/.htaccess', "Require all denied\n");

$db = new PDO('sqlite:' . $dir . '/notes.db', null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_TIMEOUT => 5,
]);
$db->exec('PRAGMA foreign_keys = ON');
$db->exec("
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  trashed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id, parent_id);
CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL);
");

$cols = array_column($db->query('PRAGMA table_info(users)')->fetchAll(), 'name');
if (!in_array('email', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
if (!in_array('sess_ver', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN sess_ver INTEGER NOT NULL DEFAULT 0');
$pcols = array_column($db->query('PRAGMA table_info(pages)')->fetchAll(), 'name');
if (!in_array('trashed_at', $pcols, true)) $db->exec('ALTER TABLE pages ADD COLUMN trashed_at INTEGER');
$db->exec('UPDATE pages SET trashed_at = ' . time() . ' WHERE trashed = 1 AND trashed_at IS NULL');
if (!in_array('email_verified', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
$db->exec("
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, email TEXT, hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS throttle (k TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_throttle ON throttle(k, ts);
");

$CFG = is_file($dir . '/config.php') ? (require $dir . '/config.php') : [];
require __DIR__ . '/lib/mail.php';

function baseUrl(): string {
    global $CFG;
    return rtrim($CFG['base_url'] ?? ('https://' . preg_replace('/[^A-Za-z0-9.:-]/', '', $_SERVER['HTTP_HOST'] ?? 'localhost')), '/');
}
function throttle(PDO $db, string $k, int $max, int $win): void {
    $db->prepare('DELETE FROM throttle WHERE ts < ?')->execute([time() - 86400]);
    $c = $db->prepare('SELECT COUNT(*) FROM throttle WHERE k = ? AND ts > ?');
    $c->execute([$k, time() - $win]);
    if ((int)$c->fetchColumn() >= $max) fail('Muitas tentativas. Tente novamente mais tarde.', 429);
}
function hit(PDO $db, string $k): void { $db->prepare('INSERT INTO throttle (k, ts) VALUES (?, ?)')->execute([$k, time()]); }
function clientIp(): string { return $_SERVER['REMOTE_ADDR'] ?? '?'; }
function cleanEmail(string $e): string {
    $e = strtolower(trim($e));
    if (strlen($e) > 120 || !filter_var($e, FILTER_VALIDATE_EMAIL)) fail('Informe um e-mail válido');
    return $e;
}
function tokenMake(PDO $db, int $uid, string $kind, ?string $email, int $ttl): string {
    $db->prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?')->execute([$uid, $kind]);
    $raw = bin2hex(random_bytes(32));
    $db->prepare('INSERT INTO tokens (user_id, kind, email, hash, expires) VALUES (?, ?, ?, ?, ?)')
       ->execute([$uid, $kind, $email, hash('sha256', $raw), time() + $ttl]);
    return $raw;
}
function tokenUse(PDO $db, string $raw, string $kind): ?array {
    $s = $db->prepare('SELECT * FROM tokens WHERE hash = ? AND kind = ? AND expires > ?');
    $s->execute([hash('sha256', $raw), $kind, time()]);
    $row = $s->fetch();
    if (!$row) return null;
    $db->prepare('DELETE FROM tokens WHERE id = ?')->execute([$row['id']]);
    return $row;
}
function sendVerify(PDO $db, int $uid, string $email): void {
    throttle($db, 'mail:' . $email, 3, 3600);
    hit($db, 'mail:' . $email);
    $url = baseUrl() . '/?verify=' . tokenMake($db, $uid, 'verify', $email, 86400);
    [$html, $text] = mail_template('Confirme seu e-mail', 'Para ativar sua conta no Workflow SLOM, confirme que este endereço de e-mail é seu. O link vale por 24 horas.', 'Confirmar e-mail', $url, 'Se você não criou uma conta, ignore esta mensagem.');
    if (!send_mail($email, 'Confirme seu e-mail — Workflow SLOM', $html, $text)) error_log('SLOM: falha ao enviar e-mail de confirmacao');
}
function sendReset(PDO $db, int $uid, string $email, bool $change = false): void {
    $url = baseUrl() . '/?reset=' . tokenMake($db, $uid, 'reset', null, 3600);
    $title = $change ? 'Confirme a alteração de senha' : 'Redefinir senha';
    $intro = $change
        ? 'Você pediu para alterar a senha da sua conta no Workflow SLOM. Para confirmar que foi você, use o botão abaixo e escolha a nova senha. O link vale por 1 hora e só pode ser usado uma vez.'
        : 'Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora e só pode ser usado uma vez.';
    [$html, $text] = mail_template($title, $intro, 'Criar nova senha', $url, 'Se não foi você, ignore esta mensagem: sua senha continua a mesma.');
    if (!send_mail($email, $title . ' — Workflow SLOM', $html, $text)) error_log('SLOM: falha ao enviar e-mail de senha');
}

const TRASH_DAYS = 7;
function purgeTrash(PDO $db): void {
    $db->prepare('DELETE FROM pages WHERE trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < ?')
       ->execute([time() - TRASH_DAYS * 86400]);
}

$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 2_000_000) fail('Conteúdo muito grande', 413);
    $body = json_decode($raw, true);
    if (!is_array($body)) fail('JSON inválido');
}

if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
$uid = (int)($_SESSION['uid'] ?? 0);

function currentUser(PDO $db, int $uid): ?array {
    if (!$uid) return null;
    $s = $db->prepare('SELECT id, username, name, is_admin, email, email_verified, sess_ver FROM users WHERE id = ?');
    $s->execute([$uid]);
    return $s->fetch() ?: null;
}
$user = currentUser($db, $uid);
if ($user && (int)($_SESSION['sv'] ?? -1) !== (int)$user['sess_ver']) {   // senha trocada: derruba sessoes antigas
    $_SESSION = ['csrf' => $_SESSION['csrf']];
    $user = null; $uid = 0;
}
if ($user) unset($user['sess_ver']);
$userCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();

if ($method === 'POST') {
    $tok = $_SERVER['HTTP_X_CSRF'] ?? '';
    if (!hash_equals($_SESSION['csrf'], $tok)) fail('Sessão inválida, recarregue a página', 403);
}

function cleanUsername(string $u): string {
    $u = trim($u);
    if (!preg_match('/^[\p{L}\p{N}._@-]{3,40}$/u', $u)) fail('Usuário: 3 a 40 caracteres (letras, números, . _ - @)');
    return $u;
}
function cleanPass(string $p): string {
    if (strlen($p) < 8) fail('A senha precisa ter pelo menos 8 caracteres');
    if (strlen($p) > 200) fail('Senha muito longa');
    return $p;
}
function login(array $u): void {
    global $db;
    session_regenerate_id(true);
    $sv = $db->prepare('SELECT sess_ver FROM users WHERE id = ?');
    $sv->execute([(int)$u['id']]);
    $_SESSION['sv'] = (int)$sv->fetchColumn();
    $_SESSION['uid'] = (int)$u['id'];
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
}
function needUser(?array $u): array { return $u ?? fail('Não autenticado', 401); }

function ownPage(PDO $db, int $uid, int $id): array {
    $s = $db->prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?');
    $s->execute([$id, $uid]);
    return $s->fetch() ?: fail('Página não encontrada', 404);
}
function setTrashed(PDO $db, int $id, int $flag): void {
    $db->prepare('UPDATE pages SET trashed = ?, trashed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$flag, $flag ? time() : null, $id]);
    $kids = $db->prepare('SELECT id FROM pages WHERE parent_id = ?');
    $kids->execute([$id]);
    foreach ($kids->fetchAll(PDO::FETCH_COLUMN) as $k) setTrashed($db, (int)$k, $flag);
}

try {
    switch ($action) {
        case 'me':
            out([
                'user' => $user, 'csrf' => $_SESSION['csrf'],
                'setup' => $userCount === 0,
                'signup' => (bool)($CFG['allow_signup'] ?? true),
            ]);

        case 'setup':
            if ($userCount > 0) fail('Já configurado', 403);
            $email = cleanEmail((string)($body['email'] ?? ''));
            $pass = cleanPass((string)($body['password'] ?? ''));
            $name = trim((string)($body['name'] ?? '')) ?: strstr($email, '@', true);
            $db->prepare('INSERT INTO users (username, name, pass_hash, is_admin, email) VALUES (?, ?, ?, 1, ?)')
               ->execute([$email, mb_substr($name, 0, 80), password_hash($pass, PASSWORD_DEFAULT), $email]);
            $newId = (int)$db->lastInsertId();
            try { sendVerify($db, $newId, $email); } catch (Throwable $t) { error_log('SLOM: ' . $t->getMessage()); }
            $u = currentUser($db, $newId);
            login($u);
            unset($u['sess_ver']);
            out(['user' => $u, 'csrf' => $_SESSION['csrf']]);

        case 'register':
            if (!($CFG['allow_signup'] ?? true)) fail('Cadastro desativado', 403);
            $ip = clientIp();
            throttle($db, 'reg:' . $ip, 10, 3600);
            hit($db, 'reg:' . $ip);
            $email = cleanEmail((string)($body['email'] ?? ''));
            $pass = cleanPass((string)($body['password'] ?? ''));
            $name = trim((string)($body['name'] ?? '')) ?: strstr($email, '@', true);
            $e = $db->prepare('SELECT 1 FROM users WHERE email = ? OR username = ?');
            $e->execute([$email, $email]);
            if (!$e->fetch()) {                       // resposta igual exista ou nao (nao revela contas)
                $db->prepare('INSERT INTO users (username, name, pass_hash, email) VALUES (?, ?, ?, ?)')
                   ->execute([$email, mb_substr($name, 0, 80), password_hash($pass, PASSWORD_DEFAULT), $email]);
                sendVerify($db, (int)$db->lastInsertId(), $email);
            }
            out(['ok' => true]);

        case 'verify':
            $row = tokenUse($db, (string)($body['token'] ?? ''), 'verify');
            if (!$row) fail('Link inválido ou expirado. Peça um novo e-mail de confirmação.', 400);
            $dup = $db->prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?');
            $dup->execute([$row['email'], $row['user_id']]);
            if ($dup->fetch()) fail('Este e-mail já está em uso por outra conta', 409);
            $db->prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?')->execute([$row['email'], $row['user_id']]);
            out(['ok' => true]);

        case 'resend':
            $email = cleanEmail((string)($body['email'] ?? ''));
            throttle($db, 'resend:' . clientIp(), 10, 3600);
            hit($db, 'resend:' . clientIp());
            $s = $db->prepare('SELECT id FROM users WHERE email = ? AND email_verified = 0');
            $s->execute([$email]);
            if ($id = $s->fetchColumn()) sendVerify($db, (int)$id, $email);
            out(['ok' => true]);

        case 'forgot':
            $email = cleanEmail((string)($body['email'] ?? ''));
            throttle($db, 'forgot:' . clientIp(), 10, 3600);
            throttle($db, 'forgot:' . $email, 3, 3600);
            hit($db, 'forgot:' . clientIp()); hit($db, 'forgot:' . $email);
            $s = $db->prepare('SELECT id FROM users WHERE email = ? AND email_verified = 1');
            $s->execute([$email]);
            if ($id = $s->fetchColumn()) sendReset($db, (int)$id, $email);
            out(['ok' => true]);

        case 'reset':
            $row = tokenUse($db, (string)($body['token'] ?? ''), 'reset');
            if (!$row) fail('Link inválido ou expirado. Peça uma nova redefinição.', 400);
            $pass = cleanPass((string)($body['password'] ?? ''));
            $db->prepare('UPDATE users SET pass_hash = ?, email_verified = 1, sess_ver = sess_ver + 1 WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $row['user_id']]);
            $db->prepare('DELETE FROM tokens WHERE user_id = ?')->execute([$row['user_id']]);
            out(['ok' => true]);

        case 'email_set':
            $u = needUser($user);
            $s = $db->prepare('SELECT pass_hash FROM users WHERE id = ?');
            $s->execute([$u['id']]);
            if (!password_verify((string)($body['password'] ?? ''), (string)$s->fetchColumn())) fail('Senha incorreta', 403);
            $email = cleanEmail((string)($body['email'] ?? ''));
            $dup = $db->prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?');
            $dup->execute([$email, $u['id']]);
            if ($dup->fetch()) fail('Este e-mail já está em uso');
            sendVerify($db, (int)$u['id'], $email);
            out(['ok' => true]);

        case 'login':
            $ip = clientIp();
            $ident = strtolower(trim((string)($body['identifier'] ?? '')));
            throttle($db, 'login:' . $ip, 10, 900);
            throttle($db, 'login:id:' . $ident, 8, 900);
            $s = $db->prepare('SELECT * FROM users WHERE username = ? OR email = ?');
            $s->execute([$ident, $ident]);
            $row = $s->fetch();
            $ok = password_verify((string)($body['password'] ?? ''), $row['pass_hash'] ?? '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
            if (!$row || !$ok) {
                hit($db, 'login:' . $ip); hit($db, 'login:id:' . $ident);
                fail('E-mail ou senha incorretos', 401);
            }
            if ($row['email'] && !$row['email_verified'] && !$row['is_admin'])
                out(['error' => 'Confirme seu e-mail antes de entrar. Enviamos um link para ' . $row['email'] . '.', 'unverified' => true, 'email' => $row['email']], 403);
            $db->prepare('DELETE FROM throttle WHERE k IN (?, ?)')->execute(['login:' . $ip, 'login:id:' . $ident]);
            login($row);
            $cu = currentUser($db, (int)$row['id']);
            unset($cu['sess_ver']);
            out(['user' => $cu, 'csrf' => $_SESSION['csrf']]);

        case 'logout':
            $_SESSION = [];
            session_destroy();
            out(['ok' => true]);

        case 'users':
            $u = needUser($user);
            if (!$u['is_admin']) fail('Apenas administradores', 403);
            out(['users' => $db->query('SELECT id, username, name, is_admin FROM users ORDER BY id')->fetchAll()]);

        case 'user_add':
            $u = needUser($user);
            if (!$u['is_admin']) fail('Apenas administradores', 403);
            $username = cleanUsername((string)($body['username'] ?? ''));
            $pass = cleanPass((string)($body['password'] ?? ''));
            $name = trim((string)($body['name'] ?? '')) ?: $username;
            $e = $db->prepare('SELECT 1 FROM users WHERE username = ?');
            $e->execute([$username]);
            if ($e->fetch()) fail('Esse usuário já existe');
            $db->prepare('INSERT INTO users (username, name, pass_hash) VALUES (?, ?, ?)')
               ->execute([$username, mb_substr($name, 0, 80), password_hash($pass, PASSWORD_DEFAULT)]);
            out(['ok' => true]);

        case 'password_request':
            $u = needUser($user);
            $s = $db->prepare('SELECT email, email_verified FROM users WHERE id = ?');
            $s->execute([$u['id']]);
            $r = $s->fetch();
            if (!$r['email'] || !$r['email_verified']) fail('Confirme o e-mail da conta antes de alterar a senha.', 409);
            throttle($db, 'pwreq:' . $u['id'], 3, 3600);
            hit($db, 'pwreq:' . $u['id']);
            sendReset($db, (int)$u['id'], $r['email'], true);
            out(['ok' => true, 'email' => $r['email']]);

        case 'pages':
            $u = needUser($user);
            purgeTrash($db);
            $s = $db->prepare('SELECT id, parent_id, title, icon, position, trashed, trashed_at, updated_at FROM pages WHERE user_id = ? ORDER BY position, id');
            $s->execute([$u['id']]);
            out(['pages' => $s->fetchAll(), 'now' => time()]);

        case 'links':
            $u = needUser($user);
            $s = $db->prepare('SELECT id, title, content FROM pages WHERE user_id = ? AND trashed = 0 ORDER BY id');
            $s->execute([$u['id']]);
            $rows = $s->fetchAll();
            $byTitle = [];
            foreach ($rows as $r) {
                $k = mb_strtolower(trim($r['title']));
                if ($k !== '' && !isset($byTitle[$k])) $byTitle[$k] = (int)$r['id'];
            }
            $edges = []; $seen = [];
            foreach ($rows as $r) {
                $list = json_decode($r['content'], true);
                if (!is_array($list)) continue;
                foreach ($list as $b) {
                    if (!is_array($b) || !is_string($b['x'] ?? null)) continue;
                    if (!preg_match_all('/\[\[([^\[\]\n]{1,200})\]\]/u', $b['x'], $m)) continue;
                    foreach ($m[1] as $t) {
                        $to = $byTitle[mb_strtolower(trim($t))] ?? null;
                        $key = $r['id'] . '>' . $to;
                        if ($to === null || $to === (int)$r['id'] || isset($seen[$key])) continue;
                        $seen[$key] = 1;
                        $edges[] = ['from' => (int)$r['id'], 'to' => $to];
                    }
                }
            }
            out(['edges' => $edges]);

        case 'page':
            $u = needUser($user);
            out(['page' => ownPage($db, (int)$u['id'], (int)($_GET['id'] ?? 0))]);

        case 'page_create':
            $u = needUser($user);
            $parent = isset($body['parent_id']) && $body['parent_id'] !== null ? (int)$body['parent_id'] : null;
            if ($parent !== null) ownPage($db, (int)$u['id'], $parent);
            $pos = $db->prepare('SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE user_id = ? AND parent_id IS ?');
            $pos->execute([$u['id'], $parent]);
            $content = $body['content'] ?? [];
            if (!is_array($content)) fail('Conteúdo inválido');
            $db->prepare('INSERT INTO pages (user_id, parent_id, title, icon, content, position) VALUES (?, ?, ?, ?, ?, ?)')
               ->execute([
                   $u['id'], $parent,
                   mb_substr((string)($body['title'] ?? ''), 0, 200),
                   mb_substr((string)($body['icon'] ?? ''), 0, 8),
                   json_encode($content, JSON_UNESCAPED_UNICODE),
                   (int)$pos->fetchColumn(),
               ]);
            out(['page' => ownPage($db, (int)$u['id'], (int)$db->lastInsertId())]);

        case 'page_save':
            $u = needUser($user);
            $p = ownPage($db, (int)$u['id'], (int)($body['id'] ?? 0));
            $set = []; $args = [];
            if (array_key_exists('title', $body)) { $set[] = 'title = ?'; $args[] = mb_substr((string)$body['title'], 0, 200); }
            if (array_key_exists('icon', $body)) { $set[] = 'icon = ?'; $args[] = mb_substr((string)$body['icon'], 0, 8); }
            if (array_key_exists('content', $body)) {
                if (!is_array($body['content'])) fail('Conteúdo inválido');
                $set[] = 'content = ?'; $args[] = json_encode($body['content'], JSON_UNESCAPED_UNICODE);
            }
            if (array_key_exists('parent_id', $body)) {
                $np = $body['parent_id'] === null ? null : (int)$body['parent_id'];
                if ($np !== null) {
                    for ($a = $np; $a !== null; ) {          // impede ciclos
                        if ($a === (int)$p['id']) fail('Não é possível mover para dentro de si mesma');
                        $a = ownPage($db, (int)$u['id'], $a)['parent_id'];
                        $a = $a === null ? null : (int)$a;
                    }
                }
                $pos = $db->prepare('SELECT COALESCE(MAX(position), 0) + 1 FROM pages WHERE user_id = ? AND parent_id IS ?');
                $pos->execute([$u['id'], $np]);
                $set[] = 'parent_id = ?'; $args[] = $np;
                $set[] = 'position = ?'; $args[] = (int)$pos->fetchColumn();
            }
            if ($set) {
                $set[] = 'updated_at = CURRENT_TIMESTAMP';
                $args[] = $p['id'];
                $db->prepare('UPDATE pages SET ' . implode(', ', $set) . ' WHERE id = ?')->execute($args);
            }
            out(['ok' => true]);

        case 'page_trash':
        case 'page_restore':
            $u = needUser($user);
            $p = ownPage($db, (int)$u['id'], (int)($body['id'] ?? 0));
            setTrashed($db, (int)$p['id'], $action === 'page_trash' ? 1 : 0);
            if ($action === 'page_restore' && $p['parent_id'] !== null) {
                $par = ownPage($db, (int)$u['id'], (int)$p['parent_id']);
                if ($par['trashed']) $db->prepare('UPDATE pages SET parent_id = NULL WHERE id = ?')->execute([$p['id']]);
            }
            out(['ok' => true]);

        case 'page_delete':
            $u = needUser($user);
            $p = ownPage($db, (int)$u['id'], (int)($body['id'] ?? 0));
            if (!$p['trashed']) fail('Mova para a lixeira primeiro');
            $db->prepare('DELETE FROM pages WHERE id = ?')->execute([$p['id']]);
            out(['ok' => true]);

        default:
            fail('Ação desconhecida', 404);
    }
} catch (PDOException $e) {
    error_log('SLOM api: ' . $e->getMessage());
    fail('Erro no banco de dados', 500);
}
