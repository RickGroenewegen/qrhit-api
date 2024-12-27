const denominations = [1, 2, 5, 10, 25, 50, 100, 200, 300, 500];

function findMinCoins(target) {
    // Initialize dp array with Infinity and coins used
    const dp = new Array(target + 1).fill(Infinity);
    const coinsUsed = new Array(target + 1).fill(null).map(() => []);
    dp[0] = 0;

    // For each amount from 1 to target
    for (let i = 1; i <= target; i++) {
        // Try each denomination
        for (const coin of denominations) {
            if (coin <= i) {
                const newValue = dp[i - coin] + 1;
                if (newValue < dp[i]) {
                    dp[i] = newValue;
                    coinsUsed[i] = [...coinsUsed[i - coin], coin];
                }
            }
        }
    }

    return {
        steps: dp[target] === Infinity ? -1 : dp[target],
        coins: coinsUsed[target]
    };
}

// Test numbers from 50 to 500
for (let num = 50; num <= 500; num++) {
    const result = findMinCoins(num);
    console.log(`Number ${num} can be reached in ${result.steps} steps using: ${result.coins.join(', ')}`);
}
