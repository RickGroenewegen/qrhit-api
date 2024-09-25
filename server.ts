import express from 'express';
import bodyParser from 'body-parser';
import { generateToken, verifyToken } from './auth';
import Mollie from './mollie';
import { OrderSearch } from './interfaces/OrderSearch';
import Order from './order';

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
  const search = req.body as OrderSearch;
  const page = req.body.page || 1;
  const itemsPerPage = req.body.itemsPerPage || 10;

  const { payments, totalItems } = await mollie.getPaymentList(search, page, itemsPerPage);

  res.json({
    data: payments,
    totalItems,
    currentPage: page,
    itemsPerPage
  });
});

app.get('/download_invoice/:invoiceId', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = verifyToken(token || '');

  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { invoiceId } = req.params;
  const order = Order.getInstance();

  try {
    const invoicePath = await order.getInvoice(invoiceId);
    res.download(invoicePath);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download invoice' });
  }
});
  console.log('Server is running on port 3000');
});
