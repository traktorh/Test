export default function handler(request, response) {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.status(200).send(`
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Состав — штаб клана</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <script>window.location.href = '/';</script>
</body>
</html>
  `);
}
