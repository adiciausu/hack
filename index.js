let Forecast = require("./forecast.js");
let forecast = new Forecast();
let i = 0;
let testData = [
    [i++, 1],
    [i++, 2],
    [i++, 3],
    [i++, 1],
    [i++, 2],
    [i++, 1],
    [i++, 2],
    [i++, 3],
    [i++, 1],
    [i++, 7],
    [i++, 9],
    [i++, 12],
    [i++, 18],
    [i++, 24],
    [i++, 30]
];

console.log(forecast.forecast(testData, 100));




