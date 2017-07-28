let timeseries = require("timeseries-analysis");

module.exports = class Forecast {
    forecast(testData, count) {
        let t = new timeseries.main(testData);
        t.smoother({period: 1});

        let coeffs = t.ARLeastSquare({degree: 1});
        let forecast = 0;	// Init the value at 0.
        for (let i = 0; i < coeffs.length; i++) {	// Loop through the coefficients
            forecast += t.data[t.data.length - 1 - i][1] * coeffs[i];
        }

        testData.push([testData[testData.length - 1][0], forecast]);
        count--;

        if (count <= 0) {
            return forecast;
        } else {
            return this.forecast(testData, count);
        }

        return forecast;
    }
}