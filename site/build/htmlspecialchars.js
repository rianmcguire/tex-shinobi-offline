/**
 *
 * @authors Ted Shiu (tedshd@gmail.com)
 * @date    2017-08-06 15:24:26
 * @version $Id$
 */


var util = {
    htmlspecialchars:
        function (str) {
            console.log(str);
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        },
    htmlspecialchars_decode:
        function (str) {
            return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"");
        },
    nl2br:
        function (str) {
            return str.replace(/\n/g, "<br>");
        }
};