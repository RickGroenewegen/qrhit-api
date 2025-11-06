const ExcelJS = require('exceljs');

async function verifyExcel() {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile('/Users/rick/Library/CloudStorage/Dropbox/QRSong!/tromp.xlsx');

    const worksheet = workbook.worksheets[0];

    // Set A9 to 75
    worksheet.getCell('A9').value = 75;

    // Force recalculation by reading the formulas
    console.log('\n=== Testing with 75 sets ===\n');

    console.log('A9 (Quantity):', worksheet.getCell('A9').value);

    // Read the calculated values
    console.log('\nEigen bedrukking (Column B):');
    console.log('B9 (Boxes) formula:', worksheet.getCell('B9').formula);
    console.log('B10 (Cards) formula:', worksheet.getCell('B10').formula);
    console.log('B12 (Total) formula:', worksheet.getCell('B12').formula);
    console.log('B13 (Per stuk) formula:', worksheet.getCell('B13').formula);

    console.log('\nVoorbedrukt (Column D):');
    console.log('D9 (Boxes) formula:', worksheet.getCell('D9').formula);
    console.log('D10 (Cards) formula:', worksheet.getCell('D10').formula);
    console.log('D12 (Total) formula:', worksheet.getCell('D12').formula);
    console.log('D13 (Per stuk) formula:', worksheet.getCell('D13').formula);

    // Calculate manually based on the formulas
    console.log('\n=== Manual Calculation ===\n');

    const quantity = 75;
    const E4 = 0.335;
    const F4 = 830;
    const L4 = 5.9;
    const M4 = 250;

    console.log('Constants: E4=' + E4 + ', F4=' + F4 + ', L4=' + L4 + ', M4=' + M4);

    // Eigen bedrukking
    const B9 = (quantity * E4) + F4;
    const B10 = (quantity * L4) + M4;
    const B12 = B9 + B10;
    const B13 = B12 / quantity;

    console.log('\nEigen bedrukking (B):');
    console.log('B9 (Boxes):', B9.toFixed(2));
    console.log('B10 (Cards):', B10.toFixed(2));
    console.log('B12 (Total):', B12.toFixed(2));
    console.log('B13 (Per stuk):', B13.toFixed(2));
    console.log('Total check: ' + quantity + ' × ' + B13.toFixed(2) + ' = ' + (quantity * B13).toFixed(2));

    // Voorbedrukt
    const D9 = (1165 / 1000) * quantity;
    const D10 = B10; // Same as eigen
    const D12 = D9 + D10;
    const D13 = D12 / quantity;

    console.log('\nVoorbedrukt (D):');
    console.log('D9 (Boxes):', D9.toFixed(2));
    console.log('D10 (Cards):', D10.toFixed(2));
    console.log('D12 (Total):', D12.toFixed(2));
    console.log('D13 (Per stuk):', D13.toFixed(2));
    console.log('Total check: ' + quantity + ' × ' + D13.toFixed(2) + ' = ' + (quantity * D13).toFixed(2));

  } catch (error) {
    console.error('Error:', error.message);
  }
}

verifyExcel();
