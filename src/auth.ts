import jwt from 'jsonwebtoken';

export function generateToken(username: string): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ username }, secret, { expiresIn: '1h' });
}

export function verifyToken(token: string): any {
  const secret = process.env.JWT_SECRET!;
  try {
    return jwt.verify(token, secret);
  } catch (e) {
    return null;
  }
}
