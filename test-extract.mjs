import http from 'http';

const req = http.request({
  hostname: 'localhost',
  port: 9005,
  path: '/api/migrate/extract',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
}, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', data));
});

req.on('error', e => console.error('Error:', e));
req.write(JSON.stringify({ sessionId: 'test', resourceGroupId: 'test', cloudProvider: 'azure' }));
req.end();
