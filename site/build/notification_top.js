/*global $, jQuery, alert, console, window, document, angular*/
/**
 *
 * @authors Ted Shiu (tedshd@gmail.com)
 * @date    2014-10-18 13:59:58
 * @version $Id$
 */

(function () {
    function notificationTop() {
        var notifitonHideTimeout;
        function show(option) {
            var d4 = {
                    t: 3000,
                    msg: 'd4 msg'
                },
                d = new Date().getTime(),
                div = document.createElement('div'),
                t = d4.t,
                msg = d4.msg;
            if (option) {
                t = option.t || d4.t;
                msg = option.msg || d4.msg;
            }

            div.setAttribute('id', 'n-' + d);
            div.setAttribute('class', 'notification-top vertical-centering');
            div.innerHTML = '<span class="notification-top-ico"></span>' +
                '<span class="notification-top-msg">' + msg + '</span>' +
                '<span class="notification-top-close">' +
                    '<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">' +
                    '<g>' +
                    '<line id="svg_1" y2="18.5" x2="18.5" y1="1.5" x1="1.5" stroke-width="2" stroke="#444" fill="none"/>' +
                    '<line id="svg_2" y2="1.5" x2="18.5" y1="18.5" x1="1.5" stroke-width="2" stroke="#444" fill="none"/>' +
                    '</g>' +
                    '</svg>' +
                '</span>';
            document.body.appendChild(div);
            setTimeout(function () {
                document.querySelector('#n-' + d).classList.add('notification-top-show');
            }, 0);
            notifitonHideTimeout = setTimeout(function () {
                d4.dom = document.querySelector('#n-' + d);
                if (d4.dom) {
                    d4.dom.classList.remove('notification-top-show');
                    d4.dom.addEventListener('transitionend', function () {
                        d4.dom.outerHTML = '';
                        delete d4.dom;
                    });
                }
            }, t);

            var closeList = document.querySelectorAll('.notification-top-close'),
                close = closeList[closeList.length - 1],
                domList = document.querySelectorAll('.notification-top');

            close.addEventListener('click', function () {
                clearTimeout(notifitonHideTimeout);
                for (var i = domList.length - 1; i >= 0; i--) {
                    domList[i].classList.remove('notification-top-show');
                    domList[i].addEventListener('transitionend', function (e) {
                        e.target.outerHTML = '';
                        delete e.target;
                    });
                }
            });
        }

        this.show = show;
    }
    window.notificationTop = notificationTop;
})();