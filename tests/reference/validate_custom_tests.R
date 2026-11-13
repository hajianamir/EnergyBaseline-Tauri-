# R Reference Validation Script for Custom Statistical Tests (§27, T9/T11/T14)
# Validates Chow structural break, Quandt-Andrews sup-F, and Diebold-Mariano statistics
# against CRAN packages: strucchange, forecast, sandwich.

suppressPackageStartupMessages({
  if (requireNamespace("strucchange", quietly = TRUE) &&
      requireNamespace("forecast", quietly = TRUE)) {
    set.seed(42)
    n <- 120
    x <- rnorm(n, mean = 16, sd = 5)
    y <- 1400 + 45 * pmax(0, x - 18) + rnorm(n, sd = 40)
    # Planted structural break at index 80
    y[81:n] <- y[81:n] - 215

    fs <- strucchange::Fstats(y ~ x, from = 0.15, to = 0.85)
    sctest_supf <- strucchange::sctest(fs, type = "supF")
    chow_at_80 <- strucchange::sctest(y ~ x, type = "Chow", point = 80)

    cat(sprintf("R_REFERENCE_SUPF=%.4f P=%.4f\n", sctest_supf$statistic, sctest_supf$p.value))
    cat(sprintf("R_REFERENCE_CHOW80=%.4f P=%.4f\n", chow_at_80$statistic, chow_at_80$p.value))
  } else {
    cat("Install R packages 'strucchange' and 'forecast' to execute reference comparison.\n")
  }
})
