<?php
declare(strict_types=1);

/* Envio de e-mail: SMTP autenticado (recomendado) ou mail() como alternativa.
 * Configuracao em slom-data/config.php (fora da pasta publica e do Git). */

function smtp_read($fp): array {
    $text = '';
    while (($l = fgets($fp, 1024)) !== false) {
        $text .= $l;
        if (strlen($l) >= 4 && $l[3] === ' ') return [(int)substr($l, 0, 3), $text];
    }
    return [0, $text];
}
function smtp_cmd($fp, string $cmd, array $ok): bool {
    if ($cmd !== '') fwrite($fp, $cmd . "\r\n");
    [$code] = smtp_read($fp);
    return in_array($code, $ok, true);
}
function smtp_deliver(array $c, string $from, string $to, string $data): bool {
    $secure = $c['secure'] ?? 'ssl';
    $port = (int)($c['port'] ?? ($secure === 'ssl' ? 465 : 587));
    $fp = @stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . $c['host'] . ':' . $port, $en, $es, 10);
    if (!$fp) return false;
    stream_set_timeout($fp, 10);
    try {
        $me = preg_replace('/[^A-Za-z0-9.-]/', '', $_SERVER['SERVER_NAME'] ?? 'localhost') ?: 'localhost';
        if (!smtp_cmd($fp, '', [220]) || !smtp_cmd($fp, "EHLO $me", [250])) return false;
        if ($secure === 'tls') {
            if (!smtp_cmd($fp, 'STARTTLS', [220]) || !stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) return false;
            if (!smtp_cmd($fp, "EHLO $me", [250])) return false;
        }
        if (!smtp_cmd($fp, 'AUTH LOGIN', [334]) || !smtp_cmd($fp, base64_encode($c['user']), [334])
            || !smtp_cmd($fp, base64_encode($c['pass']), [235])) return false;
        if (!smtp_cmd($fp, "MAIL FROM:<$from>", [250]) || !smtp_cmd($fp, "RCPT TO:<$to>", [250, 251])
            || !smtp_cmd($fp, 'DATA', [354])) return false;
        fwrite($fp, preg_replace('/^\./m', '..', $data) . "\r\n.\r\n");
        $ok = smtp_cmd($fp, '', [250]);
        smtp_cmd($fp, 'QUIT', [221]);
        return $ok;
    } finally {
        fclose($fp);
    }
}

function send_mail(string $to, string $subject, string $html, string $text): bool {
    global $CFG, $dir;
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return false;
    if (!empty($CFG['debug_mail'])) {            // so para desenvolvimento local
        file_put_contents($dir . '/mail.log', "TO: $to\nSUBJECT: $subject\n$text\n---\n", FILE_APPEND);
        return true;
    }
    $from = $CFG['from_email'] ?? 'slom@slomdev.com';
    $name = $CFG['from_name'] ?? 'Workflow SLOM';
    $b = '=_' . bin2hex(random_bytes(8));
    $subj = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $common = [
        'Date: ' . date('r'),
        'From: =?UTF-8?B?' . base64_encode($name) . "?= <$from>",
        "Reply-To: <$from>",
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . substr(strrchr($from, '@'), 1) . '>',
        'MIME-Version: 1.0',
        "Content-Type: multipart/alternative; boundary=\"$b\"",
        'Auto-Submitted: auto-generated',
        'X-Auto-Response-Suppress: All',
    ];
    $body = "--$b\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text))
          . "--$b\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html))
          . "--$b--\r\n";
    if (!empty($CFG['smtp']['host'])) {
        $data = implode("\r\n", array_merge($common, ["To: <$to>", "Subject: $subj"])) . "\r\n\r\n" . $body;
        return smtp_deliver($CFG['smtp'], $from, $to, $data);
    }
    return @mail($to, $subj, $body, implode("\r\n", $common), '-f' . $from);
}

function mail_template(string $title, string $intro, string $label, string $url, string $note): array {
    $e = fn(string $s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $html = '<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#2b2a27">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px">'
        . '<tr><td style="font-size:20px;font-weight:800;padding-bottom:20px">Workflow <span style="font-weight:400;color:#8a877f">SLOM</span></td></tr>'
        . '<tr><td style="font-size:20px;font-weight:700;padding-bottom:10px">' . $e($title) . '</td></tr>'
        . '<tr><td style="font-size:15px;line-height:1.6;padding-bottom:24px">' . $e($intro) . '</td></tr>'
        . '<tr><td style="padding-bottom:24px"><a href="' . $e($url) . '" style="background:#2f6fed;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;display:inline-block">' . $e($label) . '</a></td></tr>'
        . '<tr><td style="font-size:13px;line-height:1.5;color:#6b6860;padding-bottom:8px">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all">' . $e($url) . '</span></td></tr>'
        . '<tr><td style="font-size:13px;line-height:1.5;color:#6b6860;border-top:1px solid #e5e3dd;padding-top:16px">' . $e($note) . '</td></tr>'
        . '</table></td></tr></table></body></html>';
    $text = "$title\n\n$intro\n\n$label: $url\n\n$note\n";
    return [$html, $text];
}
