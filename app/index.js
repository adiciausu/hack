let Forecast = require("./forecast.js");
let forecast = new Forecast();
let i = 0;
let testData = [
    [i++, 59414534564],
    [i++, 59414534564],
    [i++, 59414534564],
    [i++, 59414534564],
    [i++, 59414534564],
    [i++, 59414534564]
];

console.log(forecast.forecast(testData, 0));




