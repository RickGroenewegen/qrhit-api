import express from 'express';
import bodyParser from 'body-parser';
import { generateToken, verifyToken } from './auth';
import Mollie from './mollie';

const app = express();
app.use(bodyParser.json());

app.post('/validate', (req, res) => {
  const { username, password } = req.body;
  const validUsername = process.env.ENV_ADMIN_USERNAME;
  const validPassword = process.env.ENV_ADMIN_PASSWORD;

  if (username === validUsername && password === validPassword) {
    const token = generateToken(username);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/orders', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = verifyToken(token || '');

  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mollie = new Mollie();
  const search = req.body;
  const payments = await mollie.getPaymentList(search.status);

  res.json(payments);
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
