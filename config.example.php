<?php
// Copie para slom-data/config.php (fora da pasta publica) e ajuste.
return [
    'base_url'     => 'https://slomdev.com',
    'from_email'   => 'slom@slomdev.com',
    'from_name'    => 'Workflow SLOM',
    'allow_signup' => true,
    // Recomendado: SMTP da caixa slom@slomdev.com (melhor entrega que mail()).
    // 'smtp' => ['host' => 'smtp.hostinger.com', 'port' => 465, 'secure' => 'ssl', 'user' => 'slom@slomdev.com', 'pass' => '...'],
    // 'debug_mail' => true,   // apenas local: grava os e-mails em data/mail.log
];
