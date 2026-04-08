import Logger from './logger';
import { PDFDocument } from 'pdf-lib';

class PostNL {
  private static instance: PostNL;
  private logger = new Logger();
  private apiKey: string;
  private apiUrl: string;

  private constructor() {
    this.apiKey = process.env['POSTNL_API_KEY'] || '';
    this.apiUrl = process.env['POSTNL_API_URL'] || 'https://api-sandbox.postnl.nl';
  }

  public static getInstance(): PostNL {
    if (!PostNL.instance) {
      PostNL.instance = new PostNL();
    }
    return PostNL.instance;
  }

  private getSenderAddress() {
    return {
      AddressType: '02',
      CompanyName: process.env['POSTNL_SENDER_COMPANY'] || '',
      Street: process.env['POSTNL_SENDER_STREET'] || '',
      HouseNr: process.env['POSTNL_SENDER_HOUSENR'] || '',
      HouseNrExt: process.env['POSTNL_SENDER_HOUSENR_EXT'] || '',
      Zipcode: process.env['POSTNL_SENDER_ZIPCODE'] || '',
      City: process.env['POSTNL_SENDER_CITY'] || '',
      Countrycode: process.env['POSTNL_SENDER_COUNTRYCODE'] || 'NL',
    };
  }

  private buildReceiverAddress(company: any) {
    return {
      AddressType: '01',
      CompanyName: company.name || '',
      FirstName: company.contact || '',
      Street: company.address || '',
      HouseNr: company.housenumber || '',
      Zipcode: company.zipcode || '',
      City: company.city || '',
      Countrycode: company.countrycode || 'NL',
    };
  }

  private validateCompanyAddress(company: any): string[] {
    const requiredFields: { field: string; label: string }[] = [
      { field: 'address', label: 'address' },
      { field: 'housenumber', label: 'house number' },
      { field: 'city', label: 'city' },
      { field: 'zipcode', label: 'zipcode' },
      { field: 'countrycode', label: 'country code' },
      { field: 'contact', label: 'contact name' },
    ];

    return requiredFields
      .filter((f) => !company[f.field] || company[f.field].trim() === '')
      .map((f) => f.label);
  }

  private formatTimestamp(): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${dd}-${MM}-${yyyy} ${HH}:${mm}:${ss}`;
  }

  public async createShipmentLabels(companies: { id: number; name: string; contact: string; address: string; housenumber: string; city: string; zipcode: string; countrycode: string; contactemail: string; productCode?: string }[]): Promise<{
    success: boolean;
    pdfBuffer?: Buffer;
    errors?: { companyId: number; companyName: string; missingFields: string[] }[];
    error?: string;
  }> {
    try {
      if (companies.length === 0) {
        return { success: false, error: 'No companies provided' };
      }

      // Validate all addresses
      const validationErrors: { companyId: number; companyName: string; missingFields: string[] }[] = [];
      for (const company of companies) {
        const missingFields = this.validateCompanyAddress(company);
        if (missingFields.length > 0) {
          validationErrors.push({
            companyId: company.id,
            companyName: company.name,
            missingFields,
          });
        }
      }

      if (validationErrors.length > 0) {
        return { success: false, errors: validationErrors };
      }

      // Batch companies into groups of 4 (PostNL max per request)
      const batches: any[][] = [];
      for (let i = 0; i < companies.length; i += 4) {
        batches.push(companies.slice(i, i + 4));
      }

      const allLabelBuffers: Buffer[] = [];

      for (const batch of batches) {
        const shipments = batch.map((company) => ({
          Addresses: [this.buildReceiverAddress(company)],
          Contacts: [
            {
              ContactType: '01',
              Email: company.contactemail || '',
            },
          ],
          Dimension: {
            Weight: 1000,
          },
          ProductCodeDelivery: company.productCode || '2928',
        }));

        const requestBody = {
          Customer: {
            CustomerCode: process.env['POSTNL_CUSTOMER_CODE'] || 'DEVC',
            CustomerNumber: process.env['POSTNL_CUSTOMER_NUMBER'] || '11223344',
            Address: this.getSenderAddress(),
          },
          Message: {
            MessageID: crypto.randomUUID(),
            MessageTimeStamp: this.formatTimestamp(),
            Printertype: 'GraphicFile|PDF',
          },
          Shipments: shipments,
        };

        const response = await fetch(`${this.apiUrl}/v1/shipment`, {
          method: 'POST',
          headers: {
            apikey: this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          this.logger.log(`PostNL API error (${response.status}): ${errorBody}`);
          return {
            success: false,
            error: `PostNL API error: ${response.status} - ${errorBody}`,
          };
        }

        const data = await response.json();

        if (data.ResponseShipments) {
          for (const shipment of data.ResponseShipments) {
            if (shipment.Labels) {
              for (const label of shipment.Labels) {
                if (label.Content) {
                  allLabelBuffers.push(Buffer.from(label.Content, 'base64'));
                }
              }
            }
          }
        }
      }

      if (allLabelBuffers.length === 0) {
        return { success: false, error: 'No labels were generated by PostNL' };
      }

      // Merge all label PDFs into one document
      const mergedPdf = await PDFDocument.create();
      for (const labelBuffer of allLabelBuffers) {
        const labelDoc = await PDFDocument.load(labelBuffer);
        const pages = await mergedPdf.copyPages(labelDoc, labelDoc.getPageIndices());
        pages.forEach((page) => mergedPdf.addPage(page));
      }

      const mergedBuffer = Buffer.from(await mergedPdf.save());
      return { success: true, pdfBuffer: mergedBuffer };
    } catch (error: any) {
      this.logger.log(`PostNL createShipmentLabels error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}

export default PostNL;
