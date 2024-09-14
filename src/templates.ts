import * as Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import { format } from 'date-fns';

Handlebars.registerHelper('formatDate', function (dateString: string) {
  const date = new Date(dateString);
  return format(date, 'MMMM d, yyyy');
});

Handlebars.registerHelper('formatCurrency', function (currencyString) {
  const formattedString = parseFloat(currencyString)
    .toFixed(2)
    .replace('.', ',');

  return formattedString;
});

Handlebars.registerHelper(
  'formatDecimal',
  function (currencyString: string, decimals: number) {
    const formattedString = parseFloat(currencyString).toFixed(decimals);

    return formattedString;
  }
);

class Templates {
  public async render(templatePath: string, data: any): Promise<string> {
    const fullPath = `${process.env['APP_ROOT']}/templates/${templatePath}.hbs`;

    // Read the template file using fs/promises
    const templateSource = await fs.readFile(fullPath, 'utf-8');

    const template = await Handlebars.compile(templateSource);

    const renderedHTML = await template(data);

    return renderedHTML;
  }
}

export default Templates;
