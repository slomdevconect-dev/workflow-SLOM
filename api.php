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
if (!in_array('disabled', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
if (!in_array('last_login', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN last_login INTEGER');
$db->exec('CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, admin_id INTEGER, action TEXT NOT NULL, target TEXT)');
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

$db->exec("
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4da3ff',
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT, labels TEXT NOT NULL DEFAULT '[]', checklist TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, position);
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER,
  kind TEXT NOT NULL, task_id INTEGER, text TEXT NOT NULL
);
");
if (!(int)$db->query('SELECT COUNT(*) FROM projects')->fetchColumn())
    $db->exec("INSERT INTO projects (name, color, created_at) VALUES ('Geral', '#4da3ff', " . time() . ")");

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
function sendReset(PDO $db, int $uid, string $email, string $kind = 'reset'): void {
    $url = baseUrl() . '/?reset=' . tokenMake($db, $uid, 'reset', null, $kind === 'invite' ? 259200 : 3600);
    $copy = [
        'reset' => ['Redefinir senha', 'Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora e só pode ser usado uma vez.', 'Criar nova senha', 'Se não foi você, ignore esta mensagem: sua senha continua a mesma.'],
        'change' => ['Confirme a alteração de senha', 'Você pediu para alterar a senha da sua conta no Workflow SLOM. Para confirmar que foi você, use o botão abaixo e escolha a nova senha. O link vale por 1 hora e só pode ser usado uma vez.', 'Criar nova senha', 'Se não foi você, ignore esta mensagem: sua senha continua a mesma.'],
        'invite' => ['Você foi convidado para o Workflow SLOM', 'Um administrador criou uma conta para você. Use o botão abaixo para definir sua senha e começar. O link vale por 3 dias.', 'Definir minha senha', 'Se você não esperava este convite, ignore esta mensagem.'],
    ][$kind];
    [$html, $text] = mail_template($copy[0], $copy[1], $copy[2], $url, $copy[3]);
    if (!send_mail($email, $copy[0] . ' — Workflow SLOM', $html, $text)) error_log('SLOM: falha ao enviar e-mail de senha');
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
    $s = $db->prepare('SELECT id, username, name, is_admin, email, email_verified, sess_ver, disabled FROM users WHERE id = ?');
    $s->execute([$uid]);
    return $s->fetch() ?: null;
}
$user = currentUser($db, $uid);
if ($user && ($user['disabled'] || (int)($_SESSION['sv'] ?? -1) !== (int)$user['sess_ver'])) {   // senha trocada: derruba sessoes antigas
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
function needAdmin(?array $u): array {
    $u = needUser($u);
    if (!$u['is_admin']) fail('Apenas administradores', 403);
    return $u;
}
function adminLog(PDO $db, int $adminId, string $action, string $target): void {
    $db->prepare('INSERT INTO admin_log (ts, admin_id, action, target) VALUES (?, ?, ?, ?)')->execute([time(), $adminId, $action, $target]);
}


const STATUSES = ['backlog', 'todo', 'doing', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUS_LABEL = ['backlog' => 'Backlog', 'todo' => 'A fazer', 'doing' => 'Em andamento', 'review' => 'Em revisão', 'done' => 'Concluído'];

function needMember(?array $u): array {
    $u = needUser($u);
    if ($u['is_admin']) fail('Disponível apenas para membros da equipe', 403);
    return $u;
}
function memberExists(PDO $db, int $id): bool {
    $s = $db->prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 0 AND disabled = 0');
    $s->execute([$id]);
    return (bool)$s->fetch();
}
function actLog(PDO $db, int $uid, string $kind, ?int $taskId, string $text): void {
    $db->prepare('INSERT INTO activity (ts, user_id, kind, task_id, text) VALUES (?, ?, ?, ?, ?)')->execute([time(), $uid, $kind, $taskId, mb_substr($text, 0, 300)]);
}
function taskOut(array $r): array {
    $r['labels'] = json_decode($r['labels'], true) ?: [];
    $r['checklist'] = json_decode($r['checklist'], true) ?: [];
    foreach (['id', 'project_id', 'assignee_id', 'creator_id', 'position', 'created_at', 'updated_at', 'completed_at', 'comments'] as $k)
        if (isset($r[$k])) $r[$k] = (int)$r[$k];
    return $r;
}
function cleanTask(PDO $db, array $b): array {
    $title = trim((string)($b['title'] ?? ''));
    if ($title === '' || mb_strlen($title) > 200) fail('Informe um título (até 200 caracteres)');
    $desc = (string)($b['description'] ?? '');
    if (mb_strlen($desc) > 5000) fail('Descrição muito longa');
    $status = (string)($b['status'] ?? 'todo');
    $prio = (string)($b['priority'] ?? 'medium');
    if (!in_array($status, STATUSES, true)) fail('Status inválido');
    if (!in_array($prio, PRIORITIES, true)) fail('Prioridade inválida');
    $as = $b['assignee_id'] ?? null;
    $as = ($as === null || $as === '') ? null : (int)$as;
    if ($as !== null && !memberExists($db, $as)) fail('Responsável inválido');
    $pr = $b['project_id'] ?? null;
    $pr = ($pr === null || $pr === '') ? null : (int)$pr;
    if ($pr !== null) {
        $e = $db->prepare('SELECT 1 FROM projects WHERE id = ?');
        $e->execute([$pr]);
        if (!$e->fetch()) fail('Projeto inválido');
    }
    $due = $b['due_date'] ?? null;
    if ($due === '' ) $due = null;
    if ($due !== null && (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', (string)$due, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1]))) fail('Data inválida');
    $labels = [];
    foreach ((array)($b['labels'] ?? []) as $l) {
        $l = trim((string)$l);
        if ($l !== '' && !in_array($l, $labels, true)) $labels[] = mb_substr($l, 0, 24);
        if (count($labels) >= 8) break;
    }
    $check = [];
    foreach ((array)($b['checklist'] ?? []) as $c) {
        if (!is_array($c)) continue;
        $t = trim((string)($c['t'] ?? ''));
        if ($t !== '') $check[] = ['t' => mb_substr($t, 0, 200), 'd' => !empty($c['d'])];
        if (count($check) >= 50) break;
    }
    return ['title' => $title, 'description' => $desc, 'status' => $status, 'priority' => $prio,
            'assignee_id' => $as, 'project_id' => $pr, 'due_date' => $due,
            'labels' => json_encode($labels, JSON_UNESCAPED_UNICODE), 'checklist' => json_encode($check, JSON_UNESCAPED_UNICODE)];
}
function linkEdges(PDO $db, int $uid): array {
    $s = $db->prepare('SELECT id, title, content FROM pages WHERE user_id = ? AND trashed = 0 ORDER BY id');
    $s->execute([$uid]);
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
    return $edges;
}

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
            $db->prepare('UPDATE users SET last_login = ? WHERE id = ?')->execute([time(), $newId]);
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
            if ($row['disabled']) out(['error' => 'Esta conta está desativada. Fale com o administrador.'], 403);
            if ($row['email'] && !$row['email_verified'] && !$row['is_admin'])
                out(['error' => 'Confirme seu e-mail antes de entrar. Enviamos um link para ' . $row['email'] . '.', 'unverified' => true, 'email' => $row['email']], 403);
            $db->prepare('DELETE FROM throttle WHERE k IN (?, ?)')->execute(['login:' . $ip, 'login:id:' . $ident]);
            $db->prepare('UPDATE users SET last_login = ? WHERE id = ?')->execute([time(), $row['id']]);
            login($row);
            $cu = currentUser($db, (int)$row['id']);
            unset($cu['sess_ver']);
            out(['user' => $cu, 'csrf' => $_SESSION['csrf']]);

        case 'logout':
            $_SESSION = [];
            session_destroy();
            out(['ok' => true]);

        case 'admin_users':
            $u = needAdmin($user);
            $rows = $db->query('SELECT u.id, u.name, u.username, u.email, u.email_verified, u.is_admin, u.disabled, u.created_at, u.last_login,
                (SELECT COUNT(*) FROM pages p WHERE p.user_id = u.id AND p.trashed = 0) AS pages FROM users u ORDER BY u.id')->fetchAll();
            $log = $db->query('SELECT l.ts, l.action, l.target, a.name AS admin FROM admin_log l LEFT JOIN users a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 30')->fetchAll();
            out(['users' => $rows, 'log' => $log, 'me' => (int)$u['id']]);

        case 'admin_invite':
            $u = needAdmin($user);
            $email = cleanEmail((string)($body['email'] ?? ''));
            $name = trim((string)($body['name'] ?? '')) ?: strstr($email, '@', true);
            $e = $db->prepare('SELECT 1 FROM users WHERE email = ? OR username = ?');
            $e->execute([$email, $email]);
            if ($e->fetch()) fail('Já existe uma conta com este e-mail');
            $db->prepare('INSERT INTO users (username, name, pass_hash, email) VALUES (?, ?, ?, ?)')
               ->execute([$email, mb_substr($name, 0, 80), password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT), $email]);
            sendReset($db, (int)$db->lastInsertId(), $email, 'invite');
            adminLog($db, (int)$u['id'], 'convidou', $email);
            out(['ok' => true]);

        case 'admin_action':
            $u = needAdmin($user);
            $id = (int)($body['id'] ?? 0);
            $op = (string)($body['op'] ?? '');
            $s = $db->prepare('SELECT * FROM users WHERE id = ?');
            $s->execute([$id]);
            $t = $s->fetch() ?: fail('Usuário não encontrado', 404);
            $label = $t['email'] ?: $t['username'];
            $self = $id === (int)$u['id'];
            switch ($op) {
                case 'toggle_admin':
                    if ($self) fail('Você não pode alterar o próprio papel');
                    $new = $t['is_admin'] ? 0 : 1;
                    $db->prepare('UPDATE users SET is_admin = ? WHERE id = ?')->execute([$new, $id]);
                    adminLog($db, (int)$u['id'], $new ? 'promoveu a administrador' : 'removeu de administrador', $label);
                    break;
                case 'disable':
                    if ($self) fail('Você não pode desativar a própria conta');
                    $db->prepare('UPDATE users SET disabled = 1, sess_ver = sess_ver + 1 WHERE id = ?')->execute([$id]);
                    adminLog($db, (int)$u['id'], 'desativou', $label);
                    break;
                case 'enable':
                    $db->prepare('UPDATE users SET disabled = 0 WHERE id = ?')->execute([$id]);
                    adminLog($db, (int)$u['id'], 'reativou', $label);
                    break;
                case 'verify':
                    if (!$t['email']) fail('Esta conta não tem e-mail');
                    $db->prepare('UPDATE users SET email_verified = 1 WHERE id = ?')->execute([$id]);
                    adminLog($db, (int)$u['id'], 'confirmou o e-mail de', $label);
                    break;
                case 'resend':
                    if (!$t['email']) fail('Esta conta não tem e-mail');
                    if ($t['email_verified']) fail('O e-mail já está confirmado');
                    sendVerify($db, $id, $t['email']);
                    adminLog($db, (int)$u['id'], 'reenviou a confirmação de e-mail para', $label);
                    break;
                case 'reset_link':
                    if (!$t['email']) fail('Esta conta não tem e-mail');
                    throttle($db, 'adminreset:' . $id, 5, 3600);
                    hit($db, 'adminreset:' . $id);
                    sendReset($db, $id, $t['email'], 'reset');
                    adminLog($db, (int)$u['id'], 'enviou link de nova senha para', $label);
                    break;
                case 'delete':
                    if ($self) fail('Você não pode excluir a própria conta');
                    $db->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
                    adminLog($db, (int)$u['id'], 'excluiu a conta de', $label);
                    break;
                default:
                    fail('Operação inválida');
            }
            out(['ok' => true]);

        case 'password_request':
            $u = needUser($user);
            $s = $db->prepare('SELECT email, email_verified FROM users WHERE id = ?');
            $s->execute([$u['id']]);
            $r = $s->fetch();
            if (!$r['email'] || !$r['email_verified']) fail('Confirme o e-mail da conta antes de alterar a senha.', 409);
            throttle($db, 'pwreq:' . $u['id'], 3, 3600);
            hit($db, 'pwreq:' . $u['id']);
            sendReset($db, (int)$u['id'], $r['email'], 'change');
            out(['ok' => true, 'email' => $r['email']]);

        case 'pages':
            $u = needUser($user);
            purgeTrash($db);
            $s = $db->prepare('SELECT id, parent_id, title, icon, position, trashed, trashed_at, updated_at FROM pages WHERE user_id = ? ORDER BY position, id');
            $s->execute([$u['id']]);
            out(['pages' => $s->fetchAll(), 'now' => time()]);

        case 'links':
            $u = needUser($user);
            out(['edges' => linkEdges($db, (int)$u['id'])]);

        case 'tasks_all':
            needMember($user);
            $rows = $db->query('SELECT t.*, (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments FROM tasks t ORDER BY t.position, t.id')->fetchAll();
            out([
                'tasks' => array_map('taskOut', $rows),
                'projects' => $db->query('SELECT id, name, color FROM projects ORDER BY id')->fetchAll(),
                'members' => $db->query('SELECT id, name, email FROM users WHERE is_admin = 0 AND disabled = 0 ORDER BY id')->fetchAll(),
                'now' => time(),
            ]);

        case 'task_save':
            $u = needMember($user);
            $c = cleanTask($db, $body);
            $id = (int)($body['id'] ?? 0);
            if ($id) {
                $s = $db->prepare('SELECT * FROM tasks WHERE id = ?');
                $s->execute([$id]);
                $old = $s->fetch() ?: fail('Tarefa não encontrada', 404);
                $done = $c['status'] === 'done' ? ($old['completed_at'] ?: time()) : null;
                $db->prepare('UPDATE tasks SET project_id = ?, title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due_date = ?, labels = ?, checklist = ?, completed_at = ?, updated_at = ? WHERE id = ?')
                   ->execute([$c['project_id'], $c['title'], $c['description'], $c['status'], $c['priority'], $c['assignee_id'], $c['due_date'], $c['labels'], $c['checklist'], $done, time(), $id]);
                if ($old['status'] !== $c['status'])
                    actLog($db, (int)$u['id'], $c['status'] === 'done' ? 'done' : 'move', $id, ($c['status'] === 'done' ? 'concluiu' : 'moveu para ' . STATUS_LABEL[$c['status']]) . ' “' . $c['title'] . '”');
            } else {
                $pos = $db->prepare('SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE status = ?');
                $pos->execute([$c['status']]);
                $db->prepare('INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, creator_id, due_date, labels, checklist, position, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                   ->execute([$c['project_id'], $c['title'], $c['description'], $c['status'], $c['priority'], $c['assignee_id'], $u['id'], $c['due_date'], $c['labels'], $c['checklist'], (int)$pos->fetchColumn(), time(), time(), $c['status'] === 'done' ? time() : null]);
                $id = (int)$db->lastInsertId();
                actLog($db, (int)$u['id'], 'new', $id, 'criou “' . $c['title'] . '”');
            }
            out(['ok' => true, 'id' => $id]);

        case 'task_move':
            $u = needMember($user);
            $id = (int)($body['id'] ?? 0);
            $st = (string)($body['status'] ?? '');
            if (!in_array($st, STATUSES, true)) fail('Status inválido');
            $s = $db->prepare('SELECT * FROM tasks WHERE id = ?');
            $s->execute([$id]);
            $t = $s->fetch() ?: fail('Tarefa não encontrada', 404);
            $q = $db->prepare('SELECT id FROM tasks WHERE status = ? AND id <> ? ORDER BY position, id');
            $q->execute([$st, $id]);
            $list = $q->fetchAll(PDO::FETCH_COLUMN);
            array_splice($list, min(max(0, (int)($body['index'] ?? 0)), count($list)), 0, [$id]);
            $db->beginTransaction();
            $up = $db->prepare('UPDATE tasks SET position = ? WHERE id = ?');
            foreach ($list as $i => $tid) $up->execute([$i, $tid]);
            $done = $st === 'done' ? ($t['completed_at'] ?: time()) : null;
            $db->prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')->execute([$st, $done, time(), $id]);
            $db->commit();
            if ($t['status'] !== $st)
                actLog($db, (int)$u['id'], $st === 'done' ? 'done' : 'move', $id, ($st === 'done' ? 'concluiu' : 'moveu para ' . STATUS_LABEL[$st]) . ' “' . $t['title'] . '”');
            out(['ok' => true]);

        case 'task_delete':
            $u = needMember($user);
            $id = (int)($body['id'] ?? 0);
            $s = $db->prepare('SELECT title FROM tasks WHERE id = ?');
            $s->execute([$id]);
            $title = $s->fetchColumn();
            if ($title === false) fail('Tarefa não encontrada', 404);
            $db->prepare('DELETE FROM tasks WHERE id = ?')->execute([$id]);
            actLog($db, (int)$u['id'], 'del', null, 'excluiu “' . $title . '”');
            out(['ok' => true]);

        case 'task_comments':
            needMember($user);
            $s = $db->prepare('SELECT c.id, c.body, c.created_at, c.user_id, u.name FROM task_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id');
            $s->execute([(int)($_GET['id'] ?? 0)]);
            out(['comments' => $s->fetchAll()]);

        case 'task_comment_add':
            $u = needMember($user);
            $id = (int)($body['id'] ?? 0);
            $text = trim((string)($body['body'] ?? ''));
            if ($text === '' || mb_strlen($text) > 2000) fail('Escreva um comentário (até 2000 caracteres)');
            $s = $db->prepare('SELECT title FROM tasks WHERE id = ?');
            $s->execute([$id]);
            $title = $s->fetchColumn();
            if ($title === false) fail('Tarefa não encontrada', 404);
            $db->prepare('INSERT INTO task_comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')->execute([$id, $u['id'], $text, time()]);
            actLog($db, (int)$u['id'], 'comment', $id, 'comentou em “' . $title . '”');
            out(['ok' => true]);

        case 'project_save':
            $u = needMember($user);
            $name = trim((string)($body['name'] ?? ''));
            $color = (string)($body['color'] ?? '#4da3ff');
            if ($name === '' || mb_strlen($name) > 60) fail('Informe o nome do projeto (até 60 caracteres)');
            if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) fail('Cor inválida');
            $id = (int)($body['id'] ?? 0);
            if ($id) $db->prepare('UPDATE projects SET name = ?, color = ? WHERE id = ?')->execute([$name, $color, $id]);
            else $db->prepare('INSERT INTO projects (name, color, created_by, created_at) VALUES (?, ?, ?, ?)')->execute([$name, $color, $u['id'], time()]);
            out(['ok' => true]);

        case 'project_delete':
            needMember($user);
            $db->prepare('DELETE FROM projects WHERE id = ?')->execute([(int)($body['id'] ?? 0)]);
            out(['ok' => true]);

        case 'activity':
            needMember($user);
            out(['items' => $db->query('SELECT a.ts, a.kind, a.task_id, a.text, a.user_id, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 25')->fetchAll()]);

        case 'team':
            needMember($user);
            $rows = $db->query('SELECT u.id, u.name, u.email, u.last_login, u.created_at,
                (SELECT COUNT(*) FROM pages p WHERE p.user_id = u.id AND p.trashed = 0) AS pages,
                (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status <> \'done\') AS open_tasks,
                (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = \'done\') AS done_tasks
                FROM users u WHERE u.is_admin = 0 AND u.disabled = 0 ORDER BY u.id')->fetchAll();
            out(['members' => $rows]);

        case 'member_pages':
            needMember($user);
            $mid = (int)($_GET['uid'] ?? 0);
            if (!memberExists($db, $mid)) fail('Membro não encontrado', 404);
            $s = $db->prepare('SELECT id, parent_id, title, icon, position, updated_at FROM pages WHERE user_id = ? AND trashed = 0 ORDER BY position, id');
            $s->execute([$mid]);
            out(['pages' => $s->fetchAll(), 'edges' => linkEdges($db, $mid)]);

        case 'member_page':
            needMember($user);
            $s = $db->prepare('SELECT p.id, p.user_id, p.parent_id, p.title, p.icon, p.content, p.updated_at FROM pages p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.trashed = 0 AND u.is_admin = 0 AND u.disabled = 0');
            $s->execute([(int)($_GET['id'] ?? 0)]);
            out(['page' => $s->fetch() ?: fail('Página não encontrada', 404)]);

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
