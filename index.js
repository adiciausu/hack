var timeseries = require("timeseries-analysis");



var testData = [
    [0.9],
    [2.1],
    [3.1],
    [1.9],
    [8.9],
    [3.9],
    [6.9],
    [8.9]
];



var ts = new timeseries.main(testData);
var processed = ts.lwma().output();


console.log(processed);

