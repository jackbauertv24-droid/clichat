// Find all prime numbers up to a given limit using the Sieve of Eratosthenes

function findPrimes(limit) {
  if (limit < 2) return [];

  // isComposite[i] is true if i is not prime
  const isComposite = new Array(limit + 1).fill(false);

  for (let i = 2; i * i <= limit; i++) {
    if (!isComposite[i]) {
      for (let j = i * i; j <= limit; j += i) {
        isComposite[j] = true;
      }
    }
  }

  const primes = [];
  for (let i = 2; i <= limit; i++) {
    if (!isComposite[i]) primes.push(i);
  }
  return primes;
}

const LIMIT = 10000;
const primes = findPrimes(LIMIT);

console.log(`Found ${primes.length} primes up to ${LIMIT}:`);
console.log(primes.join(", "));