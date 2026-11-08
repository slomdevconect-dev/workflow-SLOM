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
    $s = $db->prepare('SELECT id, username, name, is_admin FROM users WHERE id = ?');
    $s->execute([$uid]);
    return $s->fetch() ?: null;
}
$user = currentUser($db, $uid);
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
    session_regenerate_id(true);
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
    $db->prepare('UPDATE pages SET trashed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$flag, $id]);
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
            ]);

        case 'setup':
            if ($userCount > 0) fail('Já configurado', 403);
            $username = cleanUsername((string)($body['username'] ?? ''));
            $pass = cleanPass((string)($body['password'] ?? ''));
            $name = trim((string)($body['name'] ?? '')) ?: $username;
            $db->prepare('INSERT INTO users (username, name, pass_hash, is_admin) VALUES (?, ?, ?, 1)')
               ->execute([$username, mb_substr($name, 0, 80), password_hash($pass, PASSWORD_DEFAULT)]);
            $u = currentUser($db, (int)$db->lastInsertId());
            login($u);
            out(['user' => $u, 'csrf' => $_SESSION['csrf']]);

        case 'login':
            $ip = $_SERVER['REMOTE_ADDR'] ?? '?';
            $db->prepare('DELETE FROM attempts WHERE ts < ?')->execute([time() - 900]);
            $c = $db->prepare('SELECT COUNT(*) FROM attempts WHERE ip = ?');
            $c->execute([$ip]);
            if ((int)$c->fetchColumn() >= 8) fail('Muitas tentativas. Aguarde 15 minutos.', 429);
            $s = $db->prepare('SELECT * FROM users WHERE username = ?');
            $s->execute([trim((string)($body['username'] ?? ''))]);
            $row = $s->fetch();
            $ok = password_verify((string)($body['password'] ?? ''), $row['pass_hash'] ?? '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
            if (!$row || !$ok) {
                $db->prepare('INSERT INTO attempts (ip, ts) VALUES (?, ?)')->execute([$ip, time()]);
                fail('Usuário ou senha incorretos', 401);
            }
            $db->prepare('DELETE FROM attempts WHERE ip = ?')->execute([$ip]);
            login($row);
            out(['user' => currentUser($db, (int)$row['id']), 'csrf' => $_SESSION['csrf']]);

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

        case 'password':
            $u = needUser($user);
            $s = $db->prepare('SELECT pass_hash FROM users WHERE id = ?');
            $s->execute([$u['id']]);
            if (!password_verify((string)($body['current'] ?? ''), (string)$s->fetchColumn())) fail('Senha atual incorreta', 403);
            $new = cleanPass((string)($body['password'] ?? ''));
            $db->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')->execute([password_hash($new, PASSWORD_DEFAULT), $u['id']]);
            out(['ok' => true]);

        case 'pages':
            $u = needUser($user);
            $s = $db->prepare('SELECT id, parent_id, title, icon, position, trashed, updated_at FROM pages WHERE user_id = ? ORDER BY position, id');
            $s->execute([$u['id']]);
            out(['pages' => $s->fetchAll()]);

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
