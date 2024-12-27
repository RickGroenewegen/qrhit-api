const denominations = [1, 2, 5, 10, 25, 50, 100, 200, 300, 500];

function findMinCoins(target) {
    // Initialize dp array with Infinity
    const dp = new Array(target + 1).fill(Infinity);
    dp[0] = 0;

    // For each amount from 1 to target
    for (let i = 1; i <= target; i++) {
        // Try each denomination
        for (const coin of denominations) {
            if (coin <= i) {
                dp[i] = Math.min(dp[i], dp[i - coin] + 1);
            }
        }
    }

    return dp[target] === Infinity ? -1 : dp[target];
}

// Test numbers from 50 to 500
for (let num = 50; num <= 500; num++) {
    const steps = findMinCoins(num);
    console.log(`Number ${num} can be reached in ${steps} steps`);
}
