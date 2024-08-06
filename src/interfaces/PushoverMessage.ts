export interface PushoverMessage {
  token?: string;
  user?: string;
  message: string;
  title?: string;
  url?: string;
  url_title?: string;
  priority?: number;
  sound?: string;
  device?: string;
}
