// Load environment variables from .env file
const dotenv = require('dotenv');
dotenv.config();

// Import the required AWS SDK v3 modules
const {
  CloudFrontClient,
  CreateInvalidationCommand,
} = require('@aws-sdk/client-cloudfront');
const { fromEnv } = require('@aws-sdk/credential-provider-env');

// Configure the AWS SDK with your region and credentials
const cloudfrontClient = new CloudFrontClient({
  region: 'us-east-1', // Change to your region
  credentials: fromEnv({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }),
});

// Function to create an invalidation
const invalidateCloudFront = async (distributionId, paths) => {
  const params = {
    DistributionId: distributionId, // Your CloudFront distribution ID
    InvalidationBatch: {
      CallerReference: `invalidate-${Date.now()}`, // Unique string to ensure the request is unique
      Paths: {
        Quantity: paths.length,
        Items: paths,
      },
    },
  };

  try {
    const command = new CreateInvalidationCommand(params);
    const data = await cloudfrontClient.send(command);
    console.log('Invalidation created:', data);
  } catch (err) {
    console.error('Error creating invalidation:', err);
  }
};

// Example usage
const distributionId = process.env['AWS_CLOUDFRONT_DISTRIBUTION_ID']; // Replace with your CloudFront distribution ID
const pathsToInvalidate = ['/*']; // Replace with the paths you want to invalidate

invalidateCloudFront(distributionId, pathsToInvalidate);
